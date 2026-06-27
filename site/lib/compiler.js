// src/compiler.js
//
// Compiles a small, controlled-English risk policy into deterministic rule
// objects. This is deliberately NOT an LLM-based parser: the whole point of
// a circuit breaker is that it cannot be talked out of tripping, so the
// compiler is a plain finite grammar with one unambiguous parse per line.
//
// Grammar (one rule per line):
//
//   <ACTION> IF <METRIC> <OP> <VALUE>[%] [OVER <N> TRADES]
//
//   ACTION  := WARN | PAUSE | HALT | KILL
//   METRIC  := drawdown | hhi | winRate | sharpe | dailyLossUsd
//            | exposurePct | tradeFrequency   (aliases below)
//   OP      := > | >= | < | <= | ==
//   VALUE   := number, optionally followed by %
//   N       := integer trade-count window (optional, falls back to a
//              sensible per-metric default)
//
// Lines starting with # are comments. Blank lines are ignored.

const ACTIONS = new Set(['WARN', 'PAUSE', 'HALT', 'KILL']);

// Severity order lets the enforcer know which action "wins" when several
// rules fire on the same trade event.
export const ACTION_SEVERITY = { WARN: 1, PAUSE: 2, HALT: 3, KILL: 4 };

// Canonical metric name -> friendly aliases a policy author might type.
const METRIC_ALIASES = {
  drawdown: 'drawdown',
  dd: 'drawdown',
  hhi: 'hhi',
  concentration: 'hhi',
  winrate: 'winRate',
  win_rate: 'winRate',
  sharpe: 'sharpe',
  sharperatio: 'sharpe',
  dailylossusd: 'dailyLossUsd',
  dailyloss: 'dailyLossUsd',
  daily_loss: 'dailyLossUsd',
  exposurepct: 'exposurePct',
  exposure: 'exposurePct',
  tradefrequency: 'tradeFrequency',
  frequency: 'tradeFrequency',
};

// Metrics that are written as a percentage in policy text (e.g. "5%") but
// stored internally as a 0..1 fraction, because that's what metrics.js emits.
const PERCENT_METRICS = new Set(['drawdown', 'winRate', 'exposurePct']);

// Metrics that are evaluated over a rolling COUNT of trades, and therefore
// accept "OVER N TRADES". drawdown is peak-vs-current equity (no window),
// dailyLossUsd resets on the UTC day, and tradeFrequency is time-windowed —
// none of those take a trade-count window, so the compiler rejects "OVER N
// TRADES" on them rather than silently ignoring it.
const WINDOWED_METRICS = new Set(['hhi', 'exposurePct', 'winRate', 'sharpe']);

// Default rolling-window size (in trades), used when a policy line on a
// windowed metric omits "OVER N TRADES".
const DEFAULT_WINDOW = {
  hhi: 20,
  winRate: 20,
  sharpe: 30,
  exposurePct: 20,
};

const LINE_RE =
  /^(WARN|PAUSE|HALT|KILL)\s+IF\s+([A-Za-z_]+)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)(%)?\s*(?:OVER\s+(\d+)\s+TRADES)?\s*$/i;

const OPS = {
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
};

export class PolicyCompileError extends Error {
  constructor(message, { line, lineNumber, source }) {
    super(`Line ${lineNumber}: ${message}\n  > ${source}`);
    this.name = 'PolicyCompileError';
    this.line = line;
    this.lineNumber = lineNumber;
    this.source = source;
  }
}

/**
 * Compile raw policy text into an array of immutable rule objects.
 * Throws PolicyCompileError on the first line that doesn't parse — a
 * circuit breaker that fails open on a typo is worse than no circuit
 * breaker at all, so this never "guesses" a line's meaning.
 */
export function compilePolicy(rawText) {
  const lines = rawText.split(/\r?\n/);
  const rules = [];
  let ruleSeq = 0;

  lines.forEach((rawLine, idx) => {
    const lineNumber = idx + 1;
    const line = rawLine.trim();

    if (line === '' || line.startsWith('#')) return;

    const match = LINE_RE.exec(line);
    if (!match) {
      throw new PolicyCompileError(
        'Could not parse this line against the policy grammar ' +
          '(<ACTION> IF <METRIC> <OP> <VALUE>[%] [OVER <N> TRADES]).',
        { line, lineNumber, source: rawLine }
      );
    }

    const [, actionRaw, metricRaw, opRaw, valueRaw, pctRaw, windowRaw] = match;
    const action = actionRaw.toUpperCase();
    if (!ACTIONS.has(action)) {
      throw new PolicyCompileError(`Unknown action "${actionRaw}".`, {
        line,
        lineNumber,
        source: rawLine,
      });
    }

    const metricKey = METRIC_ALIASES[metricRaw.toLowerCase()];
    if (!metricKey) {
      throw new PolicyCompileError(
        `Unknown metric "${metricRaw}". Known metrics: ${[
          ...new Set(Object.values(METRIC_ALIASES)),
        ].join(', ')}.`,
        { line, lineNumber, source: rawLine }
      );
    }

    const isPercent = Boolean(pctRaw);
    if (isPercent && !PERCENT_METRICS.has(metricKey)) {
      throw new PolicyCompileError(
        `"${metricKey}" is not a percentage metric — drop the % sign.`,
        { line, lineNumber, source: rawLine }
      );
    }

    if (windowRaw && !WINDOWED_METRICS.has(metricKey)) {
      throw new PolicyCompileError(
        `"${metricKey}" isn't evaluated over a trade count, so it can't take "OVER N TRADES". ` +
          `(drawdown is whole-equity-curve, dailyLossUsd resets daily, tradeFrequency is time-windowed.)`,
        { line, lineNumber, source: rawLine }
      );
    }

    let value = parseFloat(valueRaw);
    if (isPercent) value = value / 100;

    const window = WINDOWED_METRICS.has(metricKey)
      ? windowRaw
        ? parseInt(windowRaw, 10)
        : DEFAULT_WINDOW[metricKey]
      : null;

    ruleSeq += 1;
    const describe = () => {
      const shownValue = isPercent ? `${(value * 100).toFixed(2)}%` : value;
      const windowTxt = window ? ` over ${window} trades` : '';
      return `${action} if ${metricKey} ${opRaw} ${shownValue}${windowTxt}`;
    };

    rules.push(
      Object.freeze({
        id: `R${ruleSeq}`,
        action,
        metric: metricKey,
        op: opRaw,
        value,
        window,
        sourceLine: lineNumber,
        source: rawLine.trim(),
        // A short, judge-readable restatement of the rule, always derived
        // from the compiled fields (never hand-written), so it can never
        // drift from what actually gets enforced.
        describe,
      })
    );
  });

  if (rules.length === 0) {
    throw new PolicyCompileError('Policy file contains no rules.', {
      line: '',
      lineNumber: 0,
      source: '(empty policy)',
    });
  }

  return rules;
}

/**
 * Evaluate one compiled rule against a live MetricsEngine. Each rule asks
 * for its own window, so two rules on the same metric with different
 * windows are both evaluated correctly from the same underlying engine.
 */
export function evaluateRule(rule, metricsEngine) {
  let observed;
  switch (rule.metric) {
    case 'drawdown':
      observed = metricsEngine.getDrawdown();
      break;
    case 'dailyLossUsd':
      observed = metricsEngine.getDailyLossUsd();
      break;
    case 'tradeFrequency':
      observed = metricsEngine.getTradeFrequency();
      break;
    case 'hhi':
      observed = metricsEngine.getHHI(rule.window);
      break;
    case 'exposurePct':
      observed = metricsEngine.getExposurePct(rule.window);
      break;
    case 'winRate':
      observed = metricsEngine.getWinRate(rule.window);
      break;
    case 'sharpe':
      observed = metricsEngine.getSharpe(rule.window);
      break;
    default:
      return { fired: false };
  }

  if (observed === undefined || observed === null) return { fired: false };
  const fired = OPS[rule.op](observed, rule.value);
  return { fired, observed };
}

export { METRIC_ALIASES, PERCENT_METRICS, WINDOWED_METRICS, DEFAULT_WINDOW };
