#!/usr/bin/env node
// src/cli.js
//
// Zero-dependency CLI. Uses only Node built-ins (node:util's parseArgs,
// node:fs, node:http) — there is nothing to `npm install` to run any of
// this.
//
// Commands:
//   compile  --policy <file>
//   simulate --policy <file> [--trades N] [--seed N] [--agent name] [--out dir]
//   run      --policy <file> --feed <jsonl> [--agent name] [--out dir]
//   verify   --log <jsonl>
//   serve    [--dir dashboard] [--log file] [--metrics file] [--port 4173]

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compilePolicy, PolicyCompileError } from './compiler.js';
import { MetricsEngine } from './metrics.js';
import { Enforcer } from './enforcer.js';
import { AuditLog } from './auditLog.js';
import { createDryRunAdapter } from './adapters/dryRunAdapter.js';
import { generateSyntheticFeed } from './syntheticFeed.js';
import { pollTickers } from './liveFeed/bitgetPublicFeed.js';
import { LiveAgent } from './liveAgent.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function readPolicy(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`Could not read policy file: ${path}\n${err.message}`);
    process.exit(1);
  }
}

function compileOrExit(path) {
  const text = readPolicy(path);
  try {
    return compilePolicy(text);
  } catch (err) {
    if (err instanceof PolicyCompileError) {
      console.error(`✗ Policy failed to compile:\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function cmdCompile(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { policy: { type: 'string' } },
  });
  if (!values.policy) {
    console.error('Usage: cli.js compile --policy <file>');
    process.exit(1);
  }
  const rules = compileOrExit(values.policy);
  console.log(`✓ Compiled ${rules.length} rule(s) from ${values.policy}\n`);
  for (const r of rules) {
    console.log(`  ${r.id.padEnd(4)} [${r.action.padEnd(5)}] ${r.describe()}`);
  }
}

async function runFeed({ rules, trades, agentId, outDir }) {
  if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const metrics = new MetricsEngine({ initialBalanceUsd: trades[0]?.balanceUsd ?? 10_000 });
  const auditLogPath = outDir ? join(outDir, 'output-audit-log.jsonl') : undefined;
  // AuditLog resumes an existing chain by default (the right behavior for a
  // long-running agent restarting). A CLI invocation should instead produce
  // one complete, self-contained run each time it's called — so start fresh.
  if (auditLogPath && existsSync(auditLogPath)) unlinkSync(auditLogPath);
  const auditLog = new AuditLog({ filePath: auditLogPath });
  const adapter = createDryRunAdapter();
  const enforcer = new Enforcer({ rules, adapter, auditLog, metrics, agentId });

  let lastSnapshot = null;
  let processedCount = 0;
  let blockedCount = 0;

  for (const trade of trades) {
    // This is the same check guardAgentHubTools() makes on a real
    // order-placement call: once the enforcer has left RUNNING, no further
    // trade reaches the "exchange" — which here just means we stop feeding
    // the simulated fill into the engine at all.
    if (!enforcer.isTradingAllowed()) {
      blockedCount += 1;
      continue;
    }

    const { snapshot, fired } = await enforcer.processTrade(trade);
    lastSnapshot = snapshot;
    processedCount += 1;

    for (const { rule, observed } of fired) {
      const tag = rule.action === 'WARN' ? 'WARN ' : 'TRIP ';
      console.log(
        `  [${tag}] trade #${snapshot.tradeCount} ${rule.id} ${rule.describe()} ` +
          `(observed ${observed}) -> agent state: ${enforcer.state}`
      );
    }
  }

  if (outDir) {
    writeFileSync(
      join(outDir, 'output-metrics.json'),
      JSON.stringify(lastSnapshot, null, 2)
    );
    writeFileSync(
      join(outDir, 'input-trades.jsonl'),
      trades.map((t) => JSON.stringify(t)).join('\n') + '\n'
    );
  }

  return { enforcer, lastSnapshot, auditLog, processedCount, blockedCount, totalCount: trades.length };
}

async function cmdSimulate(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      policy: { type: 'string' },
      trades: { type: 'string', default: '600' },
      seed: { type: 'string', default: '42' },
      agent: { type: 'string', default: 'agent-1' },
      out: { type: 'string', default: 'examples/sample-run' },
    },
  });
  if (!values.policy) {
    console.error('Usage: cli.js simulate --policy <file> [--trades N] [--seed N] [--agent name] [--out dir]');
    process.exit(1);
  }

  const rules = compileOrExit(values.policy);
  const trades = generateSyntheticFeed({
    agentId: values.agent,
    count: parseInt(values.trades, 10),
    seed: parseInt(values.seed, 10),
  });

  console.log(`Simulating ${trades.length} synthetic trades for "${values.agent}" (seed ${values.seed})...\n`);
  const { enforcer, lastSnapshot, processedCount, blockedCount, totalCount } = await runFeed({
    rules,
    trades,
    agentId: values.agent,
    outDir: values.out,
  });

  const unprotectedFinalEquity = trades[trades.length - 1].balanceUsd;
  const protectedFinalEquity = lastSnapshot?.equity ?? trades[0]?.balanceUsd ?? 0;
  const lossAvoided = unprotectedFinalEquity < protectedFinalEquity
    ? protectedFinalEquity - unprotectedFinalEquity
    : 0;

  console.log(`\nFinal agent state: ${enforcer.state}`);
  console.log(`Trades processed before the breaker stopped new fills: ${processedCount} / ${totalCount} (${blockedCount} blocked)`);
  console.log('Final metrics snapshot:', lastSnapshot);
  console.log(
    `\nUnprotected baseline equity (no circuit breaker, full ${totalCount}-trade feed): $${unprotectedFinalEquity.toFixed(2)}`
  );
  console.log(`Protected equity (breaker engaged at trade #${processedCount}):       $${protectedFinalEquity.toFixed(2)}`);
  if (lossAvoided > 0) {
    console.log(`Loss avoided by the breaker: ~$${lossAvoided.toFixed(2)}`);
  }
  console.log(`\nWrote: ${values.out}/output-audit-log.jsonl, output-metrics.json, input-trades.jsonl`);
  if (values.out) {
    writeFileSync(
      join(values.out, 'output-summary.json'),
      JSON.stringify(
        {
          agentId: values.agent,
          seed: parseInt(values.seed, 10),
          totalTrades: totalCount,
          processedTrades: processedCount,
          blockedTrades: blockedCount,
          finalState: enforcer.state,
          unprotectedFinalEquity,
          protectedFinalEquity,
          lossAvoidedUsd: lossAvoided,
        },
        null,
        2
      )
    );
  }
}

async function cmdRun(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      policy: { type: 'string' },
      feed: { type: 'string' },
      agent: { type: 'string', default: 'agent-1' },
      out: { type: 'string' },
    },
  });
  if (!values.policy || !values.feed) {
    console.error('Usage: cli.js run --policy <file> --feed <jsonl> [--agent name] [--out dir]');
    process.exit(1);
  }

  const rules = compileOrExit(values.policy);
  const trades = readFileSync(values.feed, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const { enforcer, lastSnapshot } = await runFeed({
    rules,
    trades,
    agentId: values.agent,
    outDir: values.out,
  });

  console.log(`\nFinal agent state: ${enforcer.state}`);
  console.log('Final metrics snapshot:', lastSnapshot);
}

async function cmdLive(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      policy: { type: 'string' },
      symbols: { type: 'string', default: 'BTCUSDT,ETHUSDT,SOLUSDT' },
      interval: { type: 'string', default: '4000' },
      balance: { type: 'string', default: '10000' },
      chaos: { type: 'boolean', default: false },
      duration: { type: 'string' }, // seconds; if omitted, runs until Ctrl+C
      agent: { type: 'string', default: 'live-agent' },
      out: { type: 'string', default: 'examples/live-run' },
    },
  });
  if (!values.policy) {
    console.error(
      'Usage: cli.js live --policy <file> [--symbols BTCUSDT,ETHUSDT,SOLUSDT] ' +
        '[--interval ms] [--balance usd] [--chaos] [--duration seconds] [--out dir]'
    );
    process.exit(1);
  }

  const rules = compileOrExit(values.policy);
  const startBalanceUsd = parseFloat(values.balance);
  const intervalMs = parseInt(values.interval, 10);
  const outDir = values.out;
  if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const auditLogPath = outDir ? join(outDir, 'output-audit-log.jsonl') : undefined;
  if (auditLogPath && existsSync(auditLogPath)) unlinkSync(auditLogPath); // fresh run, see runFeed() for why

  const metrics = new MetricsEngine({ initialBalanceUsd: startBalanceUsd });
  const auditLog = new AuditLog({ filePath: auditLogPath });
  const adapter = createDryRunAdapter();
  const enforcer = new Enforcer({ rules, adapter, auditLog, metrics, agentId: values.agent });

  let symbolList = values.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  let agents;

  if (values.chaos) {
    const symbol = symbolList[0];
    symbolList = [symbol]; // chaos mode is one deliberately oversized strategy, not a diversified book
    console.log(`⚠ --chaos: one deliberately reckless strategy on ${symbol} only.`);
    console.log('  The PRICES are still 100% real live Bitget data — only the position sizing');
    console.log('  (85% of balance per trade) and SMA windows (hair-trigger, length 1/3) are');
    console.log('  dialed up, so a real circuit breaker trip shows up in minutes, not days.\n');
    agents = [
      new LiveAgent({
        symbol,
        enforcer,
        startBalanceUsd,
        positionPct: 0.85,
        fastLen: 1,
        slowLen: 3,
        agentId: values.agent,
      }),
    ];
  } else {
    agents = symbolList.map(
      (symbol) =>
        new LiveAgent({
          symbol,
          enforcer,
          startBalanceUsd,
          positionPct: 0.05,
          fastLen: 5,
          slowLen: 20,
          agentId: values.agent,
        })
    );
  }

  console.log(`Live mode — polling Bitget public tickers for ${symbolList.join(', ')} every ${intervalMs}ms.`);
  console.log('All trades are PAPER ONLY: no real orders, no real capital. Ctrl+C to stop.\n');

  let tickCount = 0;
  let errorStreak = 0;

  // Serialize enforcer.processTrade() calls even if two symbols' ticks
  // resolve close together — processTrade is async (it awaits the
  // adapter), so without this, two trades arriving back-to-back could
  // interleave mid-evaluation.
  let queue = Promise.resolve();
  const enqueue = (fn) => (queue = queue.then(fn, fn));

  function writeOutputs() {
    if (!outDir) return;
    writeFileSync(join(outDir, 'output-metrics.json'), JSON.stringify(metrics.snapshot(), null, 2));
    writeFileSync(
      join(outDir, 'output-summary.json'),
      JSON.stringify(
        {
          mode: values.chaos ? 'chaos' : 'normal',
          symbols: symbolList,
          startBalanceUsd,
          protectedFinalEquity: metrics.currentEquity,
          tradeCount: metrics.tradeCount,
          tickCount,
          finalState: enforcer.state,
        },
        null,
        2
      )
    );
  }

  const stopPolling = pollTickers(
    symbolList,
    intervalMs,
    (tickData) => {
      tickCount += 1;
      errorStreak = 0;
      for (const agent of agents) {
        if (agent.symbol !== tickData.symbol) continue;
        if (!enforcer.isTradingAllowed()) continue; // the guard: same check guardAgentHubTools makes
        const trade = agent.onTick(tickData);
        if (!trade) continue;
        enqueue(() =>
          enforcer.processTrade(trade).then(({ fired }) => {
            console.log(
              `[${tickData.symbol}] ${trade.side.toUpperCase()} @ ${trade.price} qty=${trade.qty} ` +
                `pnl=${trade.pnlUsd} -> balance=${trade.balanceUsd}`
            );
            for (const { rule, observed } of fired) {
              console.log(`  ⚡ ${rule.id} ${rule.describe()} (observed ${observed}) -> agent state: ${enforcer.state}`);
            }
            writeOutputs();
          })
        );
      }
      writeOutputs();
    },
    (err, symbol) => {
      errorStreak += 1;
      console.error(`[warn] could not fetch ${symbol}: ${err.message}`);
      if (errorStreak === 3) {
        console.error(
          '\nRepeated fetch failures. If you are running inside a network-restricted sandbox, ' +
            'api.bitget.com is probably not on its allowlist — run this on a machine with normal ' +
            'internet access instead. See README "Live mode".\n'
        );
      }
    }
  );

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    stopPolling();
    queue.then(() => {
      writeOutputs();
      console.log(
        `\nStopped. Final state: ${enforcer.state}. Ticks seen: ${tickCount}. Trades: ${metrics.tradeCount}. ` +
          `Equity: $${metrics.currentEquity.toFixed(2)}.`
      );
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  if (values.duration) {
    setTimeout(shutdown, parseInt(values.duration, 10) * 1000);
  }
}

async function cmdVerify(argv) {
  const { values } = parseArgs({ args: argv, options: { log: { type: 'string' } } });
  if (!values.log) {
    console.error('Usage: cli.js verify --log <jsonl>');
    process.exit(1);
  }
  const result = AuditLog.verifyFile(values.log);
  if (result.ok) {
    console.log(`✓ Audit log verified: ${result.entries} entries, hash chain intact.`);
  } else {
    console.error(`✗ Audit log FAILED verification at entry ${result.brokenAt} (${result.reason}).`);
    process.exit(1);
  }
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
};

async function cmdServe(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string', default: join(__dirname, '..', 'dashboard') },
      log: { type: 'string', default: join(__dirname, '..', 'examples', 'sample-run', 'output-audit-log.jsonl') },
      metrics: { type: 'string', default: join(__dirname, '..', 'examples', 'sample-run', 'output-metrics.json') },
      summary: { type: 'string', default: join(__dirname, '..', 'examples', 'sample-run', 'output-summary.json') },
      policy: { type: 'string', default: join(__dirname, '..', 'policies', 'example.policy.txt') },
      port: { type: 'string', default: '4173' },
    },
  });

  const dir = resolve(values.dir);
  const logPath = resolve(values.log);
  const metricsPath = resolve(values.metrics);
  const summaryPath = resolve(values.summary);
  const policyPath = resolve(values.policy);
  const port = parseInt(values.port, 10);

  const server = createServer((req, res) => {
    const sendJson = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.url === '/api/log') {
      try {
        sendJson(AuditLog.readFile(logPath));
      } catch {
        sendJson([]);
      }
      return;
    }
    if (req.url === '/api/metrics') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(readFileSync(metricsPath, 'utf8'));
      } catch {
        sendJson({});
      }
      return;
    }
    if (req.url === '/api/summary') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(readFileSync(summaryPath, 'utf8'));
      } catch {
        sendJson(null);
      }
      return;
    }
    if (req.url === '/api/trades') {
      try {
        const raw = readFileSync(join(dirname(logPath), 'input-trades.jsonl'), 'utf8');
        sendJson(
          raw
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        );
      } catch {
        sendJson([]);
      }
      return;
    }
    if (req.url === '/api/policy') {
      try {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(readFileSync(policyPath, 'utf8'));
      } catch {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('');
      }
      return;
    }
    if (req.url === '/api/rules') {
      try {
        const rules = compileOrExitSafe(policyPath);
        sendJson(rules.map((r) => ({
          id: r.id,
          action: r.action,
          metric: r.metric,
          description: r.describe(),
          source: r.source,
        })));
      } catch (err) {
        sendJson({ error: String(err.message || err) });
      }
      return;
    }

    const urlPath = req.url === '/' ? '/index.html' : req.url;
    const filePath = join(dir, decodeURIComponent(urlPath.split('?')[0]));
    if (!filePath.startsWith(dir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    console.log(`Dashboard:  http://localhost:${port}`);
    console.log(`Policy:     ${policyPath}`);
    console.log(`Log file:   ${logPath}`);
    console.log(`Metrics:    ${metricsPath}`);
    console.log('Ctrl+C to stop.');
  });
}

function compileOrExitSafe(path) {
  // Like compileOrExit, but for use inside the HTTP server — must not
  // call process.exit() on a bad policy, just surface the error as JSON.
  return compilePolicy(readFileSync(path, 'utf8'));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'compile':
      return cmdCompile(rest);
    case 'simulate':
      return cmdSimulate(rest);
    case 'run':
      return cmdRun(rest);
    case 'live':
      return cmdLive(rest);
    case 'verify':
      return cmdVerify(rest);
    case 'serve':
      return cmdServe(rest);
    default:
      console.log(
        [
          'Agent Circuit Compiler',
          '',
          'Usage:',
          '  node src/cli.js compile  --policy <file>',
          '  node src/cli.js simulate --policy <file> [--trades N] [--seed N] [--agent name] [--out dir]',
          '  node src/cli.js run      --policy <file> --feed <jsonl> [--agent name] [--out dir]',
          '  node src/cli.js live     --policy <file> [--symbols BTCUSDT,ETHUSDT,SOLUSDT] [--interval ms] [--balance usd] [--chaos] [--duration s] [--out dir]',
          '  node src/cli.js verify   --log <jsonl>',
          '  node src/cli.js serve    [--dir dashboard] [--log file] [--metrics file] [--port 4173]',
        ].join('\n')
      );
      process.exit(command ? 1 : 0);
  }
}

main();
