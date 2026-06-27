// test/adapters.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy } from '../src/compiler.js';
import { Enforcer, AGENT_STATES } from '../src/enforcer.js';
import { AuditLog } from '../src/auditLog.js';
import { createDryRunAdapter } from '../src/adapters/dryRunAdapter.js';
import {
  createBitgetAgentHubAdapter,
  guardAgentHubTools,
} from '../src/adapters/bitgetAgentHubAdapter.js';

class FakeMetrics {
  constructor() { this.tradeCount = 0; this.values = {}; }
  set(v) { Object.assign(this.values, v); }
  ingest() { this.tradeCount += 1; return { tradeCount: this.tradeCount }; }
  getDrawdown() { return this.values.drawdown; }
  getDailyLossUsd() { return this.values.dailyLossUsd; }
  getTradeFrequency() { return this.values.tradeFrequency; }
  getHHI() { return this.values.hhi; }
  getExposurePct() { return this.values.exposurePct; }
  getWinRate() { return this.values.winRate; }
  getSharpe() { return this.values.sharpe; }
}

describe('createDryRunAdapter', () => {
  test('records every apply() call and never throws', async () => {
    const adapter = createDryRunAdapter({ log: () => {} });
    const result = await adapter.apply('HALT', { agentId: 'a1' });
    assert.equal(result.ok, true);
    assert.equal(adapter.history.length, 1);
  });
});

describe('createBitgetAgentHubAdapter', () => {
  test('behaves like dry-run when no webhook is configured', async () => {
    const adapter = createBitgetAgentHubAdapter({ webhookUrl: null, log: () => {} });
    const result = await adapter.apply('PAUSE', { agentId: 'a1' });
    assert.equal(result.ok, true);
    assert.equal(result.webhookResult.sent, false);
  });
});

describe('guardAgentHubTools', () => {
  test('blocks a guarded trade tool once the enforcer leaves RUNNING', async () => {
    const rules = compilePolicy('HALT IF drawdown > 10%');
    const metrics = new FakeMetrics();
    const auditLog = new AuditLog({});
    const adapter = createDryRunAdapter({ log: () => {} });
    const enforcer = new Enforcer({ rules, adapter, auditLog, metrics, agentId: 'a1' });

    let callCount = 0;
    const rawClient = {
      placeOrder: async (order) => {
        callCount += 1;
        return { ok: true, order };
      },
      readMarketData: async () => ({ price: 100 }), // not guarded, should pass through untouched
    };

    const guarded = guardAgentHubTools(rawClient, enforcer);

    // Still RUNNING -> the call goes through.
    await guarded.placeOrder({ symbol: 'BTCUSDT' });
    assert.equal(callCount, 1);

    // Trip the breaker.
    metrics.set({ drawdown: 0.5 });
    await enforcer.processTrade({});
    assert.equal(enforcer.state, AGENT_STATES.HALTED);

    // Now the guarded tool must refuse, without ever calling the real one.
    await assert.rejects(() => guarded.placeOrder({ symbol: 'BTCUSDT' }), /Blocked by circuit-compiler/);
    assert.equal(callCount, 1); // unchanged - the real tool was never invoked

    // An unguarded tool name is untouched and keeps working.
    const data = await guarded.readMarketData();
    assert.equal(data.price, 100);
  });
});
