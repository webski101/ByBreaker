// src/adapters/bitgetAgentHubAdapter.js
//
// IMPORTANT, READ THIS BEFORE YOU TRUST THE NAME OF THIS FILE:
//
// Bitget Agent Hub's public MCP surface is perception-first (market data,
// signals, account reads) — it is not a remote kill-switch for a third
// party's exchange account, and this adapter does not pretend otherwise.
// What it actually does is the architecturally honest version of "plug a
// circuit breaker into Agent Hub":
//
//   guardAgentHubTools(client, enforcer, { tradeToolNames })
//
//     wraps the *trade-execution* tool functions on your own MCP client
//     (e.g. a "place_order" / "submit_trade" tool you call against Agent
//     Hub) so that every call first asks the enforcer "is this agent
//     allowed to trade right now?" — before the call ever leaves your
//     process. If a breaker has tripped, the call is rejected locally,
//     with the tripped rule named in the error, instead of ever reaching
//     the exchange.
//
// This is the same "reference-monitor" pattern used by policy-enforcement
// research for agentic systems: enforcement has to sit outside the agent's
// own reasoning loop, on the actual tool-call path, or it's just a
// suggestion in a system prompt.
//
// `createBitgetAgentHubAdapter()` below is the secondary piece — the
// notification side. It satisfies the same apply(action, ctx) interface as
// the dry-run adapter (so the Enforcer doesn't know or care which one it's
// talking to), and optionally POSTs a webhook so a human or an ops channel
// hears about the trip in real time. No Bitget credentials are required to
// run the demo; if BITGET_ENFORCEMENT_WEBHOOK isn't set, it behaves exactly
// like dry-run except for the `mode` label in the audit log.

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

export function createBitgetAgentHubAdapter({
  webhookUrl = process.env.BITGET_ENFORCEMENT_WEBHOOK ?? null,
  log = console.log,
} = {}) {
  const history = [];

  async function postWebhook(payload) {
    if (!webhookUrl) return { sent: false };
    const url = new URL(webhookUrl);
    const body = JSON.stringify(payload);
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise((resolve) => {
      const req = transport(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + (url.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve({ sent: true, status: res.statusCode }));
        }
      );
      req.on('error', (err) => resolve({ sent: false, error: err.message }));
      req.write(body);
      req.end();
    });
  }

  return {
    mode: webhookUrl ? 'bitget-agent-hub' : 'bitget-agent-hub (no webhook configured)',
    history,
    async apply(action, ctx) {
      const record = { action, ctx, at: new Date().toISOString() };
      history.push(record);
      log(
        `[bitget-agent-hub] ${action} -> agent="${ctx.agentId}"` +
          (ctx.rule ? ` rule=${ctx.rule.id} (${ctx.rule.describe()})` : '')
      );
      const webhookResult = await postWebhook({
        source: 'circuit-compiler',
        action,
        agentId: ctx.agentId,
        rule: ctx.rule ? { id: ctx.rule.id, description: ctx.rule.describe() } : null,
        observed: ctx.observed ?? null,
        at: record.at,
      });
      return { ok: true, mode: 'bitget-agent-hub', action, webhookResult };
    },
  };
}

/**
 * Wrap the trade-execution tools on an existing Agent Hub MCP client so
 * they refuse to fire while the enforcer says trading isn't allowed.
 *
 * @param {object} client          your MCP client object, e.g. the result
 *                                 of connecting to Agent Hub's MCP server
 * @param {object} enforcer        an Enforcer instance from enforcer.js
 * @param {object} [opts]
 * @param {string[]} [opts.tradeToolNames]  which method names on `client`
 *        actually place/modify orders and must be guarded. Defaults cover
 *        the common naming pattern; override if your client differs.
 */
export function guardAgentHubTools(
  client,
  enforcer,
  { tradeToolNames = ['placeOrder', 'place_order', 'submitTrade', 'submit_trade', 'cancelOrCloseAll'] } = {}
) {
  const guarded = Object.create(client);

  for (const name of tradeToolNames) {
    const original = client[name];
    if (typeof original !== 'function') continue;

    guarded[name] = async function (...args) {
      if (!enforcer.isTradingAllowed()) {
        throw new Error(
          `Blocked by circuit-compiler: agent "${enforcer.agentId}" is ${enforcer.state}. ` +
            `Call enforcer.reset({ operator, reason }) before retrying ${name}().`
        );
      }
      return original.apply(client, args);
    };
  }

  return guarded;
}
