// test/metrics.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsEngine } from '../src/metrics.js';

function trade(overrides) {
  return {
    timestamp: '2026-06-01T00:00:00.000Z',
    agentId: 'a1',
    symbol: 'BTCUSDT',
    side: 'buy',
    price: 100,
    qty: 1,
    pnlUsd: 0,
    balanceUsd: 10_000,
    ...overrides,
  };
}

describe('MetricsEngine: drawdown', () => {
  test('is zero with no trades and no losses', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000 });
    assert.equal(m.getDrawdown(), 0);
  });

  test('tracks peak-vs-current equity correctly', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000 });
    m.ingest(trade({ balanceUsd: 11_000 })); // new peak
    m.ingest(trade({ balanceUsd: 9_900 })); // 10% down from peak
    assert.equal(m.getDrawdown(), 0.1);
  });
});

describe('MetricsEngine: dailyLossUsd', () => {
  test('nets gains against losses within the same UTC day', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000 });
    m.ingest(trade({ timestamp: '2026-06-01T01:00:00Z', pnlUsd: -500, balanceUsd: 9_500 }));
    m.ingest(trade({ timestamp: '2026-06-01T02:00:00Z', pnlUsd: 300, balanceUsd: 9_800 }));
    assert.equal(m.getDailyLossUsd(), 200); // net down 200, not gross 500
  });

  test('resets at the UTC day boundary', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000 });
    m.ingest(trade({ timestamp: '2026-06-01T23:00:00Z', pnlUsd: -900, balanceUsd: 9_100 }));
    assert.equal(m.getDailyLossUsd(), 900);
    m.ingest(trade({ timestamp: '2026-06-02T00:30:00Z', pnlUsd: -50, balanceUsd: 9_050 }));
    assert.equal(m.getDailyLossUsd(), 50); // new day, fresh baseline
  });
});

describe('MetricsEngine: concentration (HHI / exposurePct)', () => {
  test('reports undefined until the window is full', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000 });
    m.ingest(trade({ symbol: 'BTCUSDT', price: 100, qty: 1 }));
    assert.equal(m.getHHI(5), undefined);
  });

  test('is 1.0 when every trade in the window is the same symbol', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000 });
    for (let i = 0; i < 5; i++) m.ingest(trade({ symbol: 'BTCUSDT', price: 100, qty: 1 }));
    assert.equal(m.getHHI(5), 1);
    assert.equal(m.getExposurePct(5), 1);
  });

  test('is lower when notional is evenly split across symbols', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000 });
    m.ingest(trade({ symbol: 'BTCUSDT', price: 100, qty: 1 })); // notional 100
    m.ingest(trade({ symbol: 'ETHUSDT', price: 100, qty: 1 })); // notional 100
    // Two equally-sized symbols -> HHI = 0.5^2 + 0.5^2 = 0.5
    assert.equal(m.getHHI(2), 0.5);
    assert.equal(m.getExposurePct(2), 0.5);
  });
});

describe('MetricsEngine: winRate', () => {
  test('ignores opening trades (pnlUsd === 0)', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000 });
    m.ingest(trade({ pnlUsd: 0 })); // open, doesn't count
    m.ingest(trade({ pnlUsd: 10 })); // win
    m.ingest(trade({ pnlUsd: -10 })); // loss
    assert.equal(m.getWinRate(2), 0.5);
  });

  test('reports undefined until window of CLOSED trades is full', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000 });
    m.ingest(trade({ pnlUsd: 10 }));
    assert.equal(m.getWinRate(3), undefined);
  });
});

describe('MetricsEngine: tradeFrequency', () => {
  test('counts only trades within the trailing time window', () => {
    const m = new MetricsEngine({ initialBalanceUsd: 10_000, frequencyWindowMs: 1000 });
    m.ingest(trade({ timestamp: '2026-06-01T00:00:00.000Z' }));
    m.ingest(trade({ timestamp: '2026-06-01T00:00:00.500Z' }));
    m.ingest(trade({ timestamp: '2026-06-01T00:00:01.100Z' })); // 1.1s after the first
    assert.equal(m.getTradeFrequency(), 2); // first trade (1.1s old) has fallen out of the 1s window
  });
});
