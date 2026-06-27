// src/liveFeed/bitgetPublicFeed.js
//
// Pulls REAL, live spot prices from Bitget's public market-data REST API.
// No API key, no signature, no account — this is the same public endpoint
// anyone can curl:
//
//   curl "https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT"
//
// IMPORTANT: this file was written and unit-tested for its parsing logic,
// but the actual outbound HTTPS call to api.bitget.com has NOT been
// exercised from the environment this was built in (that sandbox only
// allows outbound traffic to package registries, not exchange APIs).
// The endpoint and response shape below are taken directly from Bitget's
// published API docs (GET /api/v2/spot/market/tickers), but you should run
// `node src/cli.js live ...` yourself, somewhere with normal internet
// access, before relying on this for a live demo — see README "Live mode".
//
// Zero dependencies: just node:https.

import { request } from 'node:https';

const HOST = 'api.bitget.com';

/** Fetch one ticker. Resolves { symbol, price, ts }. */
export function fetchTicker(symbol) {
  return new Promise((resolve, reject) => {
    const path = `/api/v2/spot/market/tickers?symbol=${encodeURIComponent(symbol)}`;
    const req = request({ hostname: HOST, path, method: 'GET', timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          reject(new Error(`Bitget ticker response wasn't JSON: ${body.slice(0, 200)}`));
          return;
        }
        const row = parsed?.data?.[0];
        if (parsed.code !== '00000' || !row || row.lastPr === undefined) {
          reject(new Error(`Unexpected Bitget ticker response for ${symbol}: ${body.slice(0, 200)}`));
          return;
        }
        const price = parseFloat(row.lastPr);
        if (!Number.isFinite(price) || price <= 0) {
          reject(new Error(`Bitget returned a non-positive price for ${symbol}: ${row.lastPr}`));
          return;
        }
        resolve({ symbol, price, ts: Number(row.ts) || Date.now() });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out fetching ${symbol} ticker`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Poll a list of symbols every `intervalMs`, calling onTick(tick) for each
 * successfully-fetched symbol and onError(err, symbol) for failures (a
 * single bad fetch never stops the loop — it just retries next interval).
 * Returns a stop() function.
 */
export function pollTickers(symbols, intervalMs, onTick, onError = () => {}) {
  let stopped = false;
  let timer = null;

  async function tickOnce() {
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const tick = await fetchTicker(symbol);
          if (!stopped) onTick(tick);
        } catch (err) {
          if (!stopped) onError(err, symbol);
        }
      })
    );
    if (!stopped) timer = setTimeout(tickOnce, intervalMs);
  }

  tickOnce();
  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
