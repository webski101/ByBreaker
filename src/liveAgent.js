// src/liveAgent.js
//
// A deliberately simple SMA-crossover paper-trading strategy. The PRICES
// it reacts to are real (from bitgetPublicFeed.js) — the CAPITAL is not.
// No order is ever placed anywhere; this just keeps a paper balance and
// hands well-formed trade events to whatever Enforcer you give it.
//
// Before deciding to act on a tick, it calls enforcer.isTradingAllowed() —
// the exact same check guardAgentHubTools() puts in front of a real MCP
// client's order-placement tools. That's deliberate: this class is meant
// to be a stand-in for "your real agent, guarded the same way," not a
// separate code path with its own rules.
//
// `chaos: true` does NOT fake the prices — it makes the STRATEGY reckless
// (way oversized positions, a hair-trigger crossover that flips constantly)
// so a live demo can show a trip within a few minutes instead of waiting
// for organic market drama. The data stays real; only the strategy's
// judgment is deliberately bad, and that's stated up front, not hidden.

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export class LiveAgent {
  /**
   * @param {object} opts
   * @param {string} opts.symbol
   * @param {object} opts.enforcer        an Enforcer instance
   * @param {number} [opts.startBalanceUsd]
   * @param {number} [opts.positionPct]   fraction of current balance risked per position
   * @param {number} [opts.fastLen]       fast SMA length, in ticks
   * @param {number} [opts.slowLen]       slow SMA length, in ticks
   * @param {string} [opts.agentId]
   */
  constructor({
    symbol,
    enforcer,
    startBalanceUsd = 10_000,
    positionPct = 0.05,
    fastLen = 5,
    slowLen = 20,
    agentId = `live-${symbol.toLowerCase()}`,
  }) {
    this.symbol = symbol;
    this.enforcer = enforcer;
    this.balance = startBalanceUsd;
    this.positionPct = positionPct;
    this.fastLen = fastLen;
    this.slowLen = slowLen;
    this.agentId = agentId;

    this.prices = [];
    this.position = null; // { entryPrice, qty } | null
    this.tradeCount = 0;
    this.wasLong = false; // previous tick's signal, to detect a fresh crossover
  }

  _sma(n) {
    if (this.prices.length < n) return null;
    const slice = this.prices.slice(-n);
    return slice.reduce((a, b) => a + b, 0) / n;
  }

  /**
   * Feed one real price tick. Returns a trade event object if this tick
   * caused a paper trade, or null if it didn't (no signal, insufficient
   * history yet, or the enforcer currently has trading blocked).
   */
  onTick({ symbol, price, ts }) {
    if (symbol !== this.symbol) return null;

    this.prices.push(price);
    if (this.prices.length > 300) this.prices.shift();

    const fast = this._sma(this.fastLen);
    const slow = this._sma(this.slowLen);
    if (fast === null || slow === null) return null; // not enough history yet

    const wantLong = fast > slow;
    const justCrossed = wantLong !== this.wasLong;
    this.wasLong = wantLong;
    if (!justCrossed) return null; // only act on a fresh crossover, not every tick

    // This is the guard: the same check a wrapped Agent Hub client would
    // perform before letting a real order through.
    if (!this.enforcer.isTradingAllowed()) return null;

    if (wantLong && !this.position) {
      const notional = this.balance * this.positionPct;
      const qty = notional / price;
      this.position = { entryPrice: price, qty };
      return this._tradeEvent({ ts, price, side: 'buy', qty, pnlUsd: 0 });
    }

    if (!wantLong && this.position) {
      const { entryPrice, qty } = this.position;
      const pnlUsd = (price - entryPrice) * qty;
      this.balance = round(this.balance + pnlUsd, 2);
      this.position = null;
      return this._tradeEvent({ ts, price, side: 'sell', qty, pnlUsd });
    }

    return null;
  }

  _tradeEvent({ ts, price, side, qty, pnlUsd }) {
    this.tradeCount += 1;
    return {
      timestamp: new Date(ts).toISOString(),
      agentId: this.agentId,
      symbol: this.symbol,
      side,
      price: round(price, 8),
      qty: round(qty, 8),
      pnlUsd: round(pnlUsd, 2),
      balanceUsd: this.balance,
    };
  }
}
