// src/adapters/dryRunAdapter.js
//
// Default adapter. Does not touch any external system — it just records
// that an action *would* have been applied. This is what the demo and the
// test suite run against, so a judge can clone the repo and reproduce the
// exact same run with zero credentials and zero network calls.

export function createDryRunAdapter({ log = console.log } = {}) {
  const history = [];

  return {
    mode: 'dry-run',
    history,
    async apply(action, ctx) {
      const record = { action, ctx, at: new Date().toISOString() };
      history.push(record);
      log(
        `[dry-run] ${action} -> agent="${ctx.agentId}"` +
          (ctx.rule ? ` rule=${ctx.rule.id} (${ctx.rule.describe()})` : '')
      );
      return { ok: true, mode: 'dry-run', action };
    },
  };
}
