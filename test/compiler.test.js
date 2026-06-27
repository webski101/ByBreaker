// test/compiler.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy, PolicyCompileError, evaluateRule } from '../src/compiler.js';

describe('compilePolicy', () => {
  test('parses a well-formed multi-rule policy', () => {
    const rules = compilePolicy(`
      # a comment, and a blank line above

      WARN IF drawdown > 3%
      HALT IF hhi > 0.75 OVER 15 TRADES
      KILL IF dailyLossUsd > 2000
    `);
    assert.equal(rules.length, 3);
    assert.equal(rules[0].action, 'WARN');
    assert.equal(rules[0].metric, 'drawdown');
    assert.equal(rules[0].value, 0.03);
    assert.equal(rules[1].window, 15);
    assert.equal(rules[2].metric, 'dailyLossUsd');
  });

  test('resolves metric aliases case-insensitively', () => {
    const rules = compilePolicy('halt if DD > 10%');
    assert.equal(rules[0].metric, 'drawdown');
  });

  test('rejects an unparseable line instead of guessing', () => {
    assert.throws(
      () => compilePolicy('HALT WHEN drawdown is big'),
      PolicyCompileError
    );
  });

  test('rejects an unknown metric', () => {
    assert.throws(() => compilePolicy('HALT IF vibes > 10'), PolicyCompileError);
  });

  test('rejects % on a non-percentage metric', () => {
    assert.throws(() => compilePolicy('HALT IF sharpe > 50%'), PolicyCompileError);
  });

  test('rejects OVER N TRADES on a non-windowed metric', () => {
    assert.throws(
      () => compilePolicy('HALT IF drawdown > 10% OVER 20 TRADES'),
      PolicyCompileError
    );
    assert.throws(
      () => compilePolicy('HALT IF dailyLossUsd > 100 OVER 5 TRADES'),
      PolicyCompileError
    );
  });

  test('rejects an empty policy', () => {
    assert.throws(() => compilePolicy('   \n  # only comments\n'), PolicyCompileError);
  });

  test('describe() is derived from compiled fields, not hand text', () => {
    const [rule] = compilePolicy('PAUSE IF winRate < 35% OVER 20 TRADES');
    assert.equal(rule.describe(), 'PAUSE if winRate < 35.00% over 20 trades');
  });
});

describe('evaluateRule', () => {
  // A minimal stand-in for MetricsEngine — only the methods evaluateRule calls.
  function fakeEngine(values) {
    return {
      getDrawdown: () => values.drawdown,
      getDailyLossUsd: () => values.dailyLossUsd,
      getTradeFrequency: () => values.tradeFrequency,
      getHHI: () => values.hhi,
      getExposurePct: () => values.exposurePct,
      getWinRate: () => values.winRate,
      getSharpe: () => values.sharpe,
    };
  }

  test('fires when the comparison is true', () => {
    const [rule] = compilePolicy('HALT IF drawdown > 10%');
    const { fired, observed } = evaluateRule(rule, fakeEngine({ drawdown: 0.15 }));
    assert.equal(fired, true);
    assert.equal(observed, 0.15);
  });

  test('does not fire when the comparison is false', () => {
    const [rule] = compilePolicy('HALT IF drawdown > 10%');
    const { fired } = evaluateRule(rule, fakeEngine({ drawdown: 0.05 }));
    assert.equal(fired, false);
  });

  test('does not fire when the underlying metric is undefined (insufficient history)', () => {
    const [rule] = compilePolicy('PAUSE IF winRate < 35% OVER 20 TRADES');
    const { fired } = evaluateRule(rule, fakeEngine({ winRate: undefined }));
    assert.equal(fired, false);
  });
});
