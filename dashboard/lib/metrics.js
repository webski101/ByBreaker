// src/metrics.js
//
// Stateful, rolling risk-metric engine. Feed it trade events one at a time
// via ingest(trade); query it with the getX(window) methods. No external
// libraries — everything here is plain arithmetic over small in-memory
// ring buffers, so it costs nothing to run alongside an agent and never
// depends on a network call to evaluate a rule.
//
// Windows are requested PER QUERY, not fixed at construction time. Two
// different rules can watch the same metric over two different windows
// (e.g. "WARN IF hhi > 0.5 OVER 10 TRADES" and "HALT IF hhi > 0.8 OVER 30
// TRADES") and both get a correct, independently-computed answer, as long
// as the underlying buffer is kept long enough — see BUFFER_CAP below.
//
// Trade event shape (only timestamp + balanceUsd are strictly required —
// the rest unlock additional metrics):
//   {
//     timestamp:  ISO-8601 string or epoch ms,
//     agentId:    string,
//     symbol:     string,
//     side:       'buy' | 'sell',
//     price:      number,
//     qty:        number,
//     pnlUsd:     number,   // realized PnL from this trade, 0 for opens
//     balanceUsd: number,   // account equity immediately after this trade
//   }

const BUFFER_CAP = 500; // generous enough for any reasonable "OVER N TRADES"

function toEpochMs(ts) {
  return typeof ts === 'number' ? ts : new Date(ts).getTime();
}

function utcDayKey(epochMs) {
  return Math.floor(epochMs / 86400000);
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export class MetricsEngine {
  constructor({ initialBalanceUsd = 0, frequencyWindowMs = 60_000 } = {}) {
    this.peakEquity = initialBalanceUsd;
    this.currentEquity = initialBalanceUsd;
    this.tradeCount = 0;
    this.frequencyWindowMs = frequencyWindowMs;

    this._symbolNotionalBuf = []; // { symbol, notional }, capped at BUFFER_CAP
    this._closedPnlBuf = []; // pnlUsd for trades where pnlUsd !== 0
    this._returnsBuf = []; // pnlUsd / balanceBefore
    this._timestampBuf = []; // epoch ms, pruned to frequencyWindowMs (not BUFFER_CAP)

    this._dayStartEquity = initialBalanceUsd;
    this._dailyKey = null;
  }

  /** Ingest one trade event and return a generic display snapshot. */
  ingest(trade) {
    const ts = toEpochMs(trade.timestamp);
    const balanceBefore = this.currentEquity;
    const notional = Math.abs((trade.price ?? 0) * (trade.qty ?? 0));
    const pnl = trade.pnlUsd ?? 0;

    this.tradeCount += 1;

    // --- Equity / drawdown ---
    this.currentEquity =
      typeof trade.balanceUsd === 'number' ? trade.balanceUsd : balanceBefore + pnl;
    this.peakEquity = Math.max(this.peakEquity, this.currentEquity);

    // --- Daily loss (net, vs. the equity level at the start of the UTC
    //     day — resets on rollover). Gains during the day offset losses,
    //     same as a real "max daily loss" risk limit. ---
    const dayKey = utcDayKey(ts);
    if (this._dailyKey === null || dayKey !== this._dailyKey) {
      this._dailyKey = dayKey;
      this._dayStartEquity = balanceBefore;
    }

    // --- Concentration buffer (HHI + top-symbol exposure share) ---
    if (trade.symbol) {
      this._symbolNotionalBuf.push({ symbol: trade.symbol, notional });
      if (this._symbolNotionalBuf.length > BUFFER_CAP) this._symbolNotionalBuf.shift();
    }

    // --- Win-rate buffer (only trades that actually closed PnL) ---
    if (pnl !== 0) {
      this._closedPnlBuf.push(pnl);
      if (this._closedPnlBuf.length > BUFFER_CAP) this._closedPnlBuf.shift();
    }

    // --- Return buffer for the Sharpe proxy ---
    if (balanceBefore > 0) {
      this._returnsBuf.push(pnl / balanceBefore);
      if (this._returnsBuf.length > BUFFER_CAP) this._returnsBuf.shift();
    }

    // --- Trade-frequency buffer (time-windowed, not trade-count-windowed) ---
    this._timestampBuf.push(ts);
    this._timestampBuf = this._timestampBuf.filter((t) => ts - t <= this.frequencyWindowMs);

    return this.snapshot(ts);
  }

  // ---- Point-in-time, non-windowed metrics ----

  getDrawdown() {
    if (this.peakEquity <= 0) return 0;
    return round(Math.max(0, (this.peakEquity - this.currentEquity) / this.peakEquity), 6);
  }

  getDailyLossUsd() {
    return round(Math.max(0, this._dayStartEquity - this.currentEquity), 2);
  }

  getTradeFrequency() {
    return this._timestampBuf.length; // trades within frequencyWindowMs
  }

  // ---- Windowed metrics: each takes its own window size ----

  _symbolShares(window) {
    const recent = this._symbolNotionalBuf.slice(-window);
    const totals = new Map();
    let grandTotal = 0;
    for (const { symbol, notional } of recent) {
      totals.set(symbol, (totals.get(symbol) ?? 0) + notional);
      grandTotal += notional;
    }
    if (grandTotal === 0) return [];
    return [...totals.values()].map((v) => v / grandTotal);
  }

  getHHI(window) {
    if (this._symbolNotionalBuf.length < window) return undefined; // not enough history yet
    const shares = this._symbolShares(window);
    if (shares.length === 0) return 0;
    return round(shares.reduce((sum, s) => sum + s * s, 0), 6);
  }

  getExposurePct(window) {
    if (this._symbolNotionalBuf.length < window) return undefined;
    const shares = this._symbolShares(window);
    if (shares.length === 0) return 0;
    return round(Math.max(...shares), 6);
  }

  getWinRate(window) {
    if (this._closedPnlBuf.length < window) return undefined;
    const recent = this._closedPnlBuf.slice(-window);
    const wins = recent.filter((p) => p > 0).length;
    return round(wins / recent.length, 6);
  }

  getSharpe(window) {
    if (this._returnsBuf.length < window) return undefined;
    const recent = this._returnsBuf.slice(-window);
    const n = recent.length;
    const mean = recent.reduce((a, b) => a + b, 0) / n;
    const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    if (stdev === 0) return 0;
    return round(mean / stdev, 6);
  }

  /**
   * A flat, generic snapshot for display/logging (dashboard, CLI summaries).
   * Uses sensible default windows — NOT necessarily the window any given
   * compiled rule cares about. Rule evaluation always calls the getX()
   * methods above directly with the rule's own window.
   */
  snapshot(asOfMs = Date.now(), { displayWindow = 20, sharpeDisplayWindow = 30 } = {}) {
    return {
      timestamp: asOfMs,
      tradeCount: this.tradeCount,
      equity: round(this.currentEquity, 2),
      peakEquity: round(this.peakEquity, 2),
      drawdown: this.getDrawdown(),
      hhi: this.getHHI(displayWindow),
      exposurePct: this.getExposurePct(displayWindow),
      winRate: this.getWinRate(displayWindow),
      sharpe: this.getSharpe(sharpeDisplayWindow),
      dailyLossUsd: this.getDailyLossUsd(),
      tradeFrequency: this.getTradeFrequency(),
    };
  }
}
