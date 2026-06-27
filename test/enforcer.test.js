// test/enforcer.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy } from '../src/compiler.js';
import { Enforcer, AGENT_STATES } from '../src/enforcer.js';
import { AuditLog } from '../src/auditLog.js';

// A fully controllable stand-in for MetricsEngine: ingest() just bumps a
// trade counter, and every getX() reads from a plain object the test sets
// directly — so each test can script exactly what the "market" looks like
// on each trade without generating real trade data.
class FakeMetrics {
  constructor() {
    this.tradeCount = 0;
    this.values = {};
  }
  set(values) {
    Object.assign(this.values, values);
  }
  ingest() {
    this.tradeCount += 1;
    return { tradeCount: this.tradeCount };
  }
  getDrawdown() { return this.values.drawdown; }
  getDailyLossUsd() { return this.values.dailyLossUsd; }
  getTradeFrequency() { return this.values.tradeFrequency; }
  getHHI() { return this.values.hhi; }
  getExposurePct() { return this.values.exposurePct; }
  getWinRate() { return this.values.winRate; }
  getSharpe() { return this.values.sharpe; }
}

function fakeAdapter() {
  const calls = [];
  return { calls, async apply(action, ctx) { calls.push({ action, ctx }); return { ok: true }; } };
}

function setUp(policyText) {
  const rules = compilePolicy(policyText);
  const metrics = new FakeMetrics();
  const auditLog = new AuditLog({}); // in-memory, no file
  const adapter = fakeAdapter();
  const enforcer = new Enforcer({ rules, adapter, auditLog, metrics, agentId: 'test-agent' });
  return { enforcer, metrics, auditLog, adapter };
}

describe('Enforcer: basic state', () => {
  test('starts RUNNING and allows trading', () => {
    const { enforcer } = setUp('WARN IF drawdown > 5%');
    assert.equal(enforcer.state, AGENT_STATES.RUNNING);
    assert.equal(enforcer.isTradingAllowed(), true);
  });
});

describe('Enforcer: WARN is edge-triggered and never changes state', () => {
  test('fires once on crossing, stays quiet while still true, fires again after clearing', async () => {
    const { enforcer, metrics } = setUp('WARN IF drawdown > 5%');

    metrics.set({ drawdown: 0.06 });
    let { fired } = await enforcer.processTrade({});
    assert.equal(fired.length, 1);
    assert.equal(enforcer.state, AGENT_STATES.RUNNING);

    ({ fired } = await enforcer.processTrade({})); // still 0.06 -> quiet
    assert.equal(fired.length, 0);

    metrics.set({ drawdown: 0.02 }); // clears
    ({ fired } = await enforcer.processTrade({}));
    assert.equal(fired.length, 0);

    metrics.set({ drawdown: 0.09 }); // crosses again -> fires again
    ({ fired } = await enforcer.processTrade({}));
    assert.equal(fired.length, 1);
  });
});

describe('Enforcer: PAUSE/HALT/KILL escalate but never auto-downgrade', () => {
  test('escalates RUNNING -> PAUSED -> HALTED as conditions worsen', async () => {
    const { enforcer, metrics } = setUp(
      'PAUSE IF drawdown > 10%\nHALT IF drawdown > 20%'
    );

    metrics.set({ drawdown: 0.15 });
    await enforcer.processTrade({});
    assert.equal(enforcer.state, AGENT_STATES.PAUSED);
    assert.equal(enforcer.isTradingAllowed(), false);

    metrics.set({ drawdown: 0.25 });
    await enforcer.processTrade({});
    assert.equal(enforcer.state, AGENT_STATES.HALTED);
  });

  test('a milder rule firing after a worse state is already set does not downgrade it', async () => {
    const { enforcer, metrics } = setUp(
      'KILL IF dailyLossUsd > 1000\nPAUSE IF drawdown > 5%'
    );

    metrics.set({ dailyLossUsd: 1500, drawdown: 0.01 });
    await enforcer.processTrade({});
    assert.equal(enforcer.state, AGENT_STATES.KILLED);

    // Now the PAUSE condition becomes true too — but PAUSE is milder than
    // KILLED, so it must not move the agent "backwards".
    metrics.set({ drawdown: 0.06 });
    const { fired } = await enforcer.processTrade({});
    assert.equal(fired.length, 1); // the rule still fires and gets logged...
    assert.equal(enforcer.state, AGENT_STATES.KILLED); // ...but state is untouched
  });

  test('a tripped breaker does not re-evaluate on later trades', async () => {
    const { enforcer, metrics } = setUp('HALT IF drawdown > 10%');
    metrics.set({ drawdown: 0.5 });
    const first = await enforcer.processTrade({});
    assert.equal(first.fired.length, 1);
    const second = await enforcer.processTrade({}); // condition still true
    assert.equal(second.fired.length, 0); // but breaker already tripped, so silent
  });
});

describe('Enforcer: reset()', () => {
  test('requires both an operator and a reason', async () => {
    const { enforcer } = setUp('HALT IF drawdown > 10%');
    await assert.rejects(() => enforcer.reset({}), /operator/);
  });

  test('clears a tripped breaker and returns to RUNNING when nothing else is tripped', async () => {
    const { enforcer, metrics } = setUp('HALT IF drawdown > 10%');
    metrics.set({ drawdown: 0.5 });
    await enforcer.processTrade({});
    assert.equal(enforcer.state, AGENT_STATES.HALTED);

    const { state } = await enforcer.reset({ operator: 'ops@example.com', reason: 'reviewed, restarting' });
    assert.equal(state, AGENT_STATES.RUNNING);
    assert.equal(enforcer.isTradingAllowed(), true);
  });

  test('stays halted if a second breaker is still tripped after a per-rule reset', async () => {
    const { enforcer, metrics } = setUp(
      'HALT IF drawdown > 10%\nHALT IF dailyLossUsd > 1000'
    );
    metrics.set({ drawdown: 0.5, dailyLossUsd: 2000 });
    await enforcer.processTrade({});
    assert.equal(enforcer.state, AGENT_STATES.HALTED);

    const { state } = await enforcer.reset({
      ruleId: 'R1',
      operator: 'ops@example.com',
      reason: 'drawdown breaker only',
    });
    assert.equal(state, AGENT_STATES.HALTED); // R2 is still tripped
  });
});

describe('Enforcer: every trip and reset is written to the audit log', () => {
  test('audit log records BOOT, TRIP, and RESET entries', async () => {
    const { enforcer, metrics, auditLog } = setUp('HALT IF drawdown > 10%');
    metrics.set({ drawdown: 0.5 });
    await enforcer.processTrade({});
    await enforcer.reset({ operator: 'ops', reason: 'done' });

    const types = auditLog.entries.map((e) => e.type);
    assert.deepEqual(types, ['SYSTEM', 'TRIP', 'RESET']);
    assert.equal(auditLog.verify().ok, true);
  });
});
