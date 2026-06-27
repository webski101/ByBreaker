// src/syntheticFeed.js
//
// Generates a deterministic, seeded stream of synthetic trades. No real
// capital, no exchange connection, no API keys — and because it's seeded,
// running `npm run demo` produces byte-identical output for anyone, which
// is what makes examples/sample-run/ a fair "reproduce this" artifact for
// judges rather than a cherry-picked screenshot.
//
// The story it tells: an agent trades normally and profitably for the
// first ~70% of the run, then drifts into a "runaway" failure mode —
// concentrating into one symbol and firing rapidly into a losing
// streak — which is exactly the failure pattern circuit breakers exist
// to catch before it drains the account.

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const BASE_PRICE = { BTCUSDT: 62000, ETHUSDT: 3400, SOLUSDT: 145, XRPUSDT: 0.62 };

// mulberry32 — tiny, fast, seedable PRNG. Public domain construction.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * @param {object} opts
 * @param {string} [opts.agentId]
 * @param {number} [opts.count]            total trades to generate
 * @param {number} [opts.seed]             PRNG seed — same seed, same output
 * @param {number} [opts.startBalanceUsd]
 * @param {number} [opts.runawayFraction]  fraction of the run that stays "normal" before degrading
 */
export function generateSyntheticFeed({
  agentId = 'agent-1',
  count = 600,
  seed = 42,
  startBalanceUsd = 10_000,
  runawayFraction = 0.7,
} = {}) {
  const rng = mulberry32(seed);
  const runawayAt = Math.floor(count * runawayFraction);

  let balance = startBalanceUsd;
  // Fixed anchor (NOT Date.now()) so the same seed produces byte-identical
  // output, including which UTC day each trade falls on, no matter when
  // this is actually run — that's what makes examples/sample-run/ a fair
  // "reproduce this" artifact rather than a moving target.
  let t = Date.parse('2026-06-01T00:00:00.000Z');
  const trades = [];

  const priceWalk = { ...BASE_PRICE };

  for (let i = 0; i < count; i++) {
    const isRunaway = i >= runawayAt;

    let symbol, dtMs, pnl;

    if (!isRunaway) {
      symbol = SYMBOLS[Math.floor(rng() * SYMBOLS.length)];
      dtMs = 4000 + rng() * 8000; // a trade roughly every 4-12s
      const isClose = rng() < 0.7; // 70% of trades realize PnL, 30% are opens
      if (isClose) {
        const win = rng() < 0.56; // a mildly profitable baseline strategy
        pnl = (win ? 1 : -1) * (10 + rng() * 40);
      } else {
        pnl = 0;
      }
    } else {
      // Runaway phase: concentrates into BTCUSDT, fires rapidly, loses
      // consistently — exactly what drawdown / HHI / dailyLoss /
      // tradeFrequency breakers are built to catch.
      symbol = 'BTCUSDT';
      dtMs = 200 + rng() * 700; // a trade every 0.2-0.9s
      pnl = -(50 + rng() * 150);
    }

    // simple bounded random walk per symbol, just so prices look plausible
    priceWalk[symbol] = Math.max(
      0.01,
      priceWalk[symbol] * (1 + (rng() - 0.5) * 0.004)
    );
    const price = round(priceWalk[symbol], symbol === 'XRPUSDT' ? 4 : 2);
    const qty = round((50 + rng() * 200) / price, 6);
    const side = rng() < 0.5 ? 'buy' : 'sell';

    t += dtMs;
    balance = round(balance + pnl, 2);

    trades.push({
      timestamp: new Date(t).toISOString(),
      agentId,
      symbol,
      side,
      price,
      qty,
      pnlUsd: round(pnl, 2),
      balanceUsd: balance,
    });
  }

  return trades;
}
