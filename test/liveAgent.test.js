// test/liveAgent.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LiveAgent } from '../src/liveAgent.js';

function tick(price, ts = 0) {
  return { symbol: 'BTCUSDT', price, ts };
}

describe('LiveAgent: SMA crossover on deterministic prices', () => {
  test('buys on a fresh upward crossover, holds, sells on a fresh downward crossover', () => {
    const enforcer = { isTradingAllowed: () => true };
    const agent = new LiveAgent({
      symbol: 'BTCUSDT',
      enforcer,
      startBalanceUsd: 10_000,
      positionPct: 0.1,
      fastLen: 1,
      slowLen: 2,
    });

    assert.equal(agent.onTick(tick(100)), null); // not enough history for the slow SMA yet
    assert.equal(agent.onTick(tick(100)), null); // fast(100) == slow(100), no crossover

    const buy = agent.onTick(tick(110)); // fast=110 > slow=avg(100,110)=105 -> crosses up
    assert.ok(buy);
    assert.equal(buy.side, 'buy');
    assert.equal(buy.price, 110);
    assert.equal(buy.pnlUsd, 0); // opening a position never realizes PnL

    assert.equal(agent.onTick(tick(115)), null); // still long, no new crossover -> holds

    const sell = agent.onTick(tick(90)); // fast=90 < slow=avg(115,90)=102.5 -> crosses down
    assert.ok(sell);
    assert.equal(sell.side, 'sell');
    // bought at 110, sold at 90, on qty = (10000*0.1)/110
    const expectedQty = (10_000 * 0.1) / 110;
    assert.ok(Math.abs(sell.qty - expectedQty) < 1e-9);
    const expectedPnl = (90 - 110) * expectedQty;
    assert.ok(Math.abs(sell.pnlUsd - expectedPnl) < 0.01);
    assert.equal(sell.balanceUsd, Math.round((10_000 + expectedPnl) * 100) / 100);
  });

  test('does not act on ticks for a different symbol', () => {
    const enforcer = { isTradingAllowed: () => true };
    const agent = new LiveAgent({ symbol: 'BTCUSDT', enforcer, fastLen: 1, slowLen: 2 });
    assert.equal(agent.onTick({ symbol: 'ETHUSDT', price: 9999, ts: 0 }), null);
  });

  test('is guarded by enforcer.isTradingAllowed() exactly like guardAgentHubTools', () => {
    let allowed = true;
    const enforcer = { isTradingAllowed: () => allowed };
    const agent = new LiveAgent({
      symbol: 'BTCUSDT',
      enforcer,
      startBalanceUsd: 10_000,
      positionPct: 0.1,
      fastLen: 1,
      slowLen: 2,
    });

    agent.onTick(tick(100));
    agent.onTick(tick(100));

    allowed = false; // breaker has tripped, right before what would be a buy signal
    const blocked = agent.onTick(tick(110));
    assert.equal(blocked, null);
    assert.equal(agent.position, null); // no paper position was opened

    allowed = true; // recovered
    const buy = agent.onTick(tick(120)); // still an upward signal once trading resumes... 
    // NOTE: the crossover already happened while blocked, so wasLong is now
    // already true and this tick won't look like a "fresh" cross. That's
    // intentional — re-arming is not the agent's call to make silently.
    assert.equal(buy, null);
  });
});
