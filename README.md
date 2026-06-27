# Agent Circuit Compiler

A natural-language risk policy, compiled into a deterministic enforcer that can **pause, halt, or kill** a trading agent — and that the agent's own reasoning cannot talk its way around.

Zero runtime dependencies. Node.js built-ins only.

```
HALT IF dailyLossUsd > 800
```
compiles to a rule object, gets evaluated against live trade metrics on every fill, and — the moment it's true — flips the agent into a `HALTED` state that a guarded Bitget Agent Hub client will refuse to place further orders under, no matter what the agent's own model argues.

## The problem this solves

Most "risk management" for trading agents today is a paragraph in a system prompt: *"don't risk more than 2% per trade, stop if you're down 5% today."* That's not a circuit breaker, it's a suggestion — the same reasoning loop that decided to take the bad trade is the one being asked to police itself. Research on policy enforcement for agentic systems makes the same point directly: prompt-based constraints give **no enforcement guarantee**, because the agent can misinterpret, ignore, or be talked out of them.

A real circuit breaker has to sit *outside* the agent's reasoning, on the actual path between "decide to trade" and "trade happens." That's what this is: a small, boring, deterministic state machine that an LLM cannot negotiate with.

## How it works

```
policy.txt  →  compiler.js  →  rules[]  →  enforcer.js  ←  metrics.js  ←  trade stream
                                              │
                                              ├─→ auditLog.js   (hash-chained, tamper-evident)
                                              └─→ adapters/*    (what actually stops the agent)
```

1. **Compile** — `compiler.js` parses a small controlled-English grammar (not an LLM) into immutable rule objects. One unambiguous parse per line, or a compile error — never a guess.
2. **Measure** — `metrics.js` ingests a trade stream and computes drawdown, concentration (HHI), win rate, a Sharpe proxy, net daily loss, and trade frequency, each over whatever rolling window its rule asks for.
3. **Enforce** — `enforcer.js` evaluates every rule on every trade and drives a sticky state machine: `RUNNING → PAUSED/HALTED/KILLED`. Nothing here ever auto-clears; recovery is `enforcer.reset({ operator, reason })`, always audited, always human-initiated.
4. **Stop the agent** — `adapters/bitgetAgentHubAdapter.js` exports `guardAgentHubTools(client, enforcer)`, which wraps an Agent Hub MCP client's order-placement tools so they refuse to fire while the enforcer says no — before the call ever leaves your process.
5. **Prove it** — `auditLog.js` hash-chains every trip and reset (the same construction git uses for commits). Edit or delete a past entry and `verify()` detects it.

### Policy grammar

```
<ACTION> IF <METRIC> <OP> <VALUE>[%] [OVER <N> TRADES]
```

| | |
|---|---|
| **ACTION** | `WARN` → `PAUSE` → `HALT` → `KILL` (increasing severity; state only ever escalates) |
| **METRIC** | `drawdown`, `hhi`, `winRate`, `sharpe`, `dailyLossUsd`, `exposurePct`, `tradeFrequency` |
| **OP** | `>` `>=` `<` `<=` `==` |
| **OVER N TRADES** | only valid on trade-windowed metrics (`hhi`, `winRate`, `sharpe`, `exposurePct`) — `drawdown` is whole-equity-curve, `dailyLossUsd` resets at UTC midnight, `tradeFrequency` is time-windowed, and the compiler **rejects** a window on those rather than silently ignoring it |

See [`policies/example.policy.txt`](policies/example.policy.txt) for a full working policy. A few deliberate design choices worth knowing about:

- **WARN is edge-triggered**, not a sticky breaker — it fires once when a condition crosses the threshold, stays quiet while it remains true, and can fire again after it clears. This keeps the audit log meaningful instead of one entry per trade for as long as a mild warning condition persists.
- **PAUSE/HALT/KILL are sticky.** Once a rule trips, it stays tripped — and the agent's state only ever escalates (a milder rule firing later can't downgrade `HALTED` back to `PAUSED`) — until a human calls `reset()`.
- **Windowed metrics report `undefined` until the window is full.** A single concentrated trade isn't "100% concentration risk" — it's one data point. Rules don't fire on insufficient history.

## Quick start

```bash
git clone <this-repo>
cd agent-circuit-compiler
npm run demo      # compiles policies/example.policy.txt, runs 600 seeded
                   # synthetic trades through it, writes examples/sample-run/,
                   # then verifies the audit log's hash chain
npm run serve      # http://localhost:4173 — the live breaker panel
npm test           # 42 unit tests, node's built-in test runner
```

No `npm install` is required for any of the above — there is nothing to install.

### What `npm run demo` actually shows

The bundled example policy + a seeded synthetic agent (deterministic — same seed, same output, every time, which is what makes this reproducible by a judge rather than a cherry-picked screenshot) trades normally and profitably for ~420 trades, then drifts into a "runaway" failure mode: concentrating into one symbol and firing rapidly into a losing streak. That's the exact failure pattern circuit breakers exist to catch.

```
Final agent state: PAUSED
Trades processed before the breaker stopped new fills: 423 / 600 (177 blocked)

Unprotected baseline equity (no circuit breaker, full 600-trade feed): $-12863.17
Protected equity (breaker engaged at trade #423):                      $9512.07
Loss avoided by the breaker: ~$22375.24
```

The breaker caught the drift **3 trades** into the runaway phase and capped the damage at roughly $22.4k versus what an unprotected run would have lost. `examples/sample-run/` contains the exact input trades, the resulting hash-chained audit log, and the final metrics snapshot, so this is independently reproducible: `npm run demo` again, or `node src/cli.js verify --log examples/sample-run/output-audit-log.jsonl`.

## Live mode — real prices, paper trading

Everything above runs on synthetic data. `node src/cli.js live` swaps that for **real, live spot prices from Bitget's public market API** (`GET /api/v2/spot/market/tickers` — no API key needed), driving a real SMA-crossover paper-trading strategy through the exact same compiler → metrics → enforcer → audit-log pipeline. The capital is still fake (paper balance, no orders placed anywhere); the prices it's reacting to are not.

```bash
npm run live                                    # diversified: BTC/ETH/SOL, modest sizing, until Ctrl+C
node src/cli.js live --policy policies/example.policy.txt --chaos --duration 180
```

- **Default mode** runs one small SMA-crossover strategy per symbol (BTCUSDT, ETHUSDT, SOLUSDT by default), each risking ~5% of the paper balance per position — a diversified little book, unlikely to trip anything quickly.
- **`--chaos`** does *not* fake the prices. It collapses to one strategy on one symbol with ~85% of the balance per trade and a hair-trigger crossover, so a real trip shows up in minutes instead of however long organic volatility takes. The recklessness is in the strategy's judgment, not the data.
- Every tick checks `enforcer.isTradingAllowed()` before trading — the exact same guard `guardAgentHubTools()` puts in front of a real Agent Hub client — so once a breaker trips, the live agent genuinely stops trading, the same way it would if it were wrapped around a real order-placement tool.
- Point the dashboard at it while it runs: `node src/cli.js serve --log examples/live-run/output-audit-log.jsonl --metrics examples/live-run/output-metrics.json --summary examples/live-run/output-summary.json`.

**Be aware before you rely on this for a live demo:** this was built and tested in a sandboxed environment whose outbound network is restricted to package registries — it could not actually reach `api.bitget.com` to verify connectivity. The endpoint and response shape come straight from Bitget's published API docs, and the strategy/enforcer logic around it is unit-tested (`test/liveAgent.test.js`) with synthetic price sequences, but **you should run `npm run live` yourself, somewhere with normal internet access, well before you need it on stage.** If it can't reach Bitget, it logs a clear warning and keeps retrying rather than crashing — that's also exactly what you'd see if `api.bitget.com` isn't reachable from wherever you're running it.

## Hosting the dashboard publicly (Vercel)

`site/` is a Vercel-ready copy of the dashboard, serving the real `examples/sample-run/` data as static serverless functions — a real, shareable public URL for the submission, without needing to keep anything running. See [`site/README.md`](site/README.md) for the two-minute deploy steps and what it can't do (it's a fixed snapshot, not a live re-run — for that, see "Live mode" above).

## Using this with your own agent

You don't need the synthetic feed at all — it exists for the demo. For a real agent:

```js
import { compilePolicy } from './src/compiler.js';
import { MetricsEngine } from './src/metrics.js';
import { Enforcer } from './src/enforcer.js';
import { AuditLog } from './src/auditLog.js';
import { createBitgetAgentHubAdapter, guardAgentHubTools } from './src/adapters/bitgetAgentHubAdapter.js';
import { readFileSync } from 'node:fs';

const rules = compilePolicy(readFileSync('policies/example.policy.txt', 'utf8'));
const metrics = new MetricsEngine({ initialBalanceUsd: 10_000 });
const auditLog = new AuditLog({ filePath: 'audit-log.jsonl' });
const adapter = createBitgetAgentHubAdapter(); // set BITGET_ENFORCEMENT_WEBHOOK to notify ops on a trip
const enforcer = new Enforcer({ rules, adapter, auditLog, metrics, agentId: 'my-agent' });

// Wrap whatever MCP client you already use to call Bitget Agent Hub.
const guardedAgentHub = guardAgentHubTools(myAgentHubClient, enforcer, {
  tradeToolNames: ['placeOrder'], // whatever your client actually calls them
});

// Your agent calls guardedAgentHub.placeOrder(...) exactly like before.
// After each fill actually executes, tell the enforcer about it:
const { fired } = await enforcer.processTrade({
  timestamp: new Date().toISOString(),
  agentId: 'my-agent',
  symbol: 'BTCUSDT',
  side: 'buy',
  price: 64000,
  qty: 0.01,
  pnlUsd: -12.4,
  balanceUsd: 9987.6,
});
// if `fired` is non-empty and a breaker tripped, guardedAgentHub.placeOrder()
// will start rejecting calls on the very next attempt.
```

### Being honest about what "Bitget Agent Hub integration" means here

Agent Hub's public MCP surface is perception-first — market data, signals, account reads. It is **not** a remote kill switch on a third party's exchange account, and this project doesn't pretend otherwise. What `guardAgentHubTools()` actually does is the architecturally honest version of "wire a circuit breaker into Agent Hub": it intercepts your own process's calls to Agent Hub's order-placement tools, in front of the agent's reasoning, before they ever leave your machine. That's the same reference-monitor pattern used in recent agentic-systems policy-enforcement research — enforcement has to live on the tool-call path, not in a prompt.

If you don't want to wrap your own client, `createBitgetAgentHubAdapter()` can also fire a webhook (`BITGET_ENFORCEMENT_WEBHOOK`) on every trip — useful for paging a human even if you can't wire the guard in directly.

## Project layout

```
src/
  compiler.js                  controlled-English → immutable rule objects
  metrics.js                   rolling risk metrics from a trade stream
  enforcer.js                  rules + metrics → agent state machine
  auditLog.js                  hash-chained, tamper-evident action log
  syntheticFeed.js             seeded demo data generator (not used in production)
  liveAgent.js                 SMA-crossover paper trader, guarded by the enforcer
  liveFeed/bitgetPublicFeed.js polls Bitget's public ticker API (no auth)
  cli.js                       compile / simulate / run / live / verify / serve
  adapters/
    dryRunAdapter.js           default — no external calls, used by tests + demo
    bitgetAgentHubAdapter.js   guardAgentHubTools() + webhook notifier
policies/example.policy.txt    the policy used by the demo
dashboard/index.html           standalone live breaker panel (no build step)
examples/sample-run/           checked-in, reproducible synthetic-demo output
test/                          42 tests, node's built-in test runner
```

## Honest limitations

- The policy grammar is intentionally small. It's a controlled language, not free-form English — that's a feature (determinism), but it means a real compliance officer's prose still needs translating into these lines by hand today.
- `guardAgentHubTools()` protects calls that go through the wrapped client. It cannot stop orders placed through some other path you didn't wrap.
- The demo runs entirely on synthetic, seeded data. No real capital, no live exchange connection — by design, but worth being upfront about.
- Win rate and Sharpe are computed only over trades with non-zero realized PnL; pure "opening" fills aren't counted as wins or losses.
- `AuditLog` resumes an existing chain by default if its file already exists — the right behavior for a long-running agent process restarting mid-day. The CLI's `simulate`/`run` commands instead clear any prior output file first, so each invocation produces one complete, reproducible run rather than appending to whatever was there before.

## License

MIT
