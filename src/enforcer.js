// src/enforcer.js
//
// Wires the compiled rules, the metrics engine, the audit log, and an
// adapter (the thing that actually tells an agent to stop) into one
// deterministic state machine. This module never calls an LLM and never
// asks the agent's own reasoning loop for permission — that's the whole
// thesis: a policy an agent could talk its way around isn't a circuit
// breaker, it's a suggestion.
//
// Agent-level state machine (sticky — nothing here auto-clears itself):
//   RUNNING -> PAUSED  -> RUNNING   (via reset())
//   RUNNING -> HALTED  -> RUNNING   (via reset())
//   *       -> KILLED  -> RUNNING   (via reset(); KILL is the most severe
//                                    action but not procedurally special —
//                                    every reset() call requires an
//                                    operator name and a reason, which is
//                                    what makes it auditable, not the
//                                    severity of the state being cleared.)
//
// A WARN never changes agent state — it only writes an audit entry, and
// it's edge-triggered (fires once per crossing, not once per trade).

import { evaluateRule } from './compiler.js';

export const AGENT_STATES = Object.freeze({
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  HALTED: 'HALTED',
  KILLED: 'KILLED',
});

// Action -> the agent state it forces the agent into.
const ACTION_TARGET_STATE = {
  PAUSE: AGENT_STATES.PAUSED,
  HALT: AGENT_STATES.HALTED,
  KILL: AGENT_STATES.KILLED,
};

export class Enforcer {
  /**
   * @param {object} opts
   * @param {object[]} opts.rules     compiled rules from compiler.js
   * @param {object}   opts.adapter   pause/halt/kill/resume(agentId, ctx) -> Promise|value
   * @param {object}   opts.auditLog  an AuditLog instance
   * @param {object}   opts.metrics   a MetricsEngine instance
   * @param {string}   [opts.agentId]
   */
  constructor({ rules, adapter, auditLog, metrics, agentId = 'agent-1' }) {
    this.rules = rules;
    this.adapter = adapter;
    this.auditLog = auditLog;
    this.metrics = metrics;
    this.agentId = agentId;

    this.state = AGENT_STATES.RUNNING;
    // breaker state per rule: ARMED (watching) or TRIPPED (sticky until reset)
    this.breakers = new Map(rules.map((r) => [r.id, 'ARMED']));
    // WARN rules don't trip a sticky breaker — they're edge-triggered
    // instead, so a condition that stays true doesn't spam one entry per
    // trade. This tracks whether each WARN rule was firing last time.
    this._warnActive = new Map(
      rules.filter((r) => r.action === 'WARN').map((r) => [r.id, false])
    );

    this.auditLog.append({
      type: 'SYSTEM',
      action: 'BOOT',
      agentId: this.agentId,
      description: `Compiled ${rules.length} rule(s) for ${this.agentId}.`,
    });
  }

  isTradingAllowed() {
    return this.state === AGENT_STATES.RUNNING;
  }

  /**
   * Feed one trade event through the metrics engine, evaluate every rule
   * against the resulting snapshot, and apply the most severe action that
   * fired. Returns { snapshot, fired: rule[], stateChanged }.
   */
  async processTrade(trade) {
    const snapshot = this.metrics.ingest(trade);
    const fired = [];

    for (const rule of this.rules) {
      // A breaker that already tripped stays tripped — don't re-evaluate
      // it into firing again every single trade.
      if (this.breakers.get(rule.id) === 'TRIPPED') continue;

      const { fired: didFire, observed } = evaluateRule(rule, this.metrics);

      if (rule.action === 'WARN') {
        const wasActive = this._warnActive.get(rule.id);
        this._warnActive.set(rule.id, didFire);
        if (!didFire || wasActive) continue; // only fire on the rising edge
        fired.push({ rule, observed });
        await this._applyAction(rule, observed, snapshot);
        continue;
      }

      if (!didFire) continue;
      fired.push({ rule, observed });
      this.breakers.set(rule.id, 'TRIPPED');
      await this._applyAction(rule, observed, snapshot);
    }

    return { snapshot, fired, state: this.state };
  }

  async _applyAction(rule, observed, snapshot) {
    const targetState = ACTION_TARGET_STATE[rule.action];

    // KILL always wins. Otherwise only escalate (RUNNING -> PAUSED ->
    // HALTED), never silently de-escalate a worse state to a milder one.
    const severity = (s) =>
      ({ RUNNING: 0, PAUSED: 1, HALTED: 2, KILLED: 3 }[s]);

    let applied = false;
    if (targetState && severity(targetState) > severity(this.state)) {
      this.state = targetState;
      applied = true;
      await Promise.resolve(
        this.adapter.apply(rule.action, {
          agentId: this.agentId,
          rule,
          observed,
        })
      );
    }

    this.auditLog.append({
      type: rule.action === 'WARN' ? 'WARN' : 'TRIP',
      agentId: this.agentId,
      ruleId: rule.id,
      action: rule.action,
      metric: rule.metric,
      threshold: rule.value,
      observed,
      resultingState: this.state,
      stateChangeApplied: applied,
      description: `${rule.describe()} — observed ${rule.metric}=${observed} (trade #${snapshot.tradeCount})`,
    });
  }

  /**
   * Manually clear one or all breakers and (if every breaker is clear)
   * return the agent to RUNNING. This is the human-in-the-loop step — the
   * compiler/enforcer will never do this on its own.
   */
  async reset({ ruleId = null, operator, reason }) {
    if (!operator || !reason) {
      throw new Error('reset() requires both an operator name and a reason — resets are audited.');
    }

    if (ruleId) {
      this.breakers.set(ruleId, 'ARMED');
    } else {
      for (const id of this.breakers.keys()) this.breakers.set(id, 'ARMED');
    }

    const stillTripped = [...this.breakers.values()].some((s) => s === 'TRIPPED');
    const previousState = this.state;
    if (!stillTripped) {
      this.state = AGENT_STATES.RUNNING;
      await Promise.resolve(this.adapter.apply('RESUME', { agentId: this.agentId }));
    }

    this.auditLog.append({
      type: 'RESET',
      agentId: this.agentId,
      ruleId,
      operator,
      reason,
      previousState,
      resultingState: this.state,
      description: ruleId
        ? `${operator} manually cleared breaker ${ruleId}: ${reason}`
        : `${operator} manually cleared all breakers: ${reason}`,
    });

    return { state: this.state };
  }
}
