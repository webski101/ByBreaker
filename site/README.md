# site/ — Vercel-deployable dashboard

This is a static, Vercel-ready copy of the live breaker panel (`dashboard/index.html`), serving a fixed snapshot of the real, reproducible demo run committed at `examples/sample-run/`.

**What's real:** the data. `scripts/generate-site-data.mjs` reads the actual `examples/sample-run/*` files and runs the actual `compilePolicy()` from `src/compiler.js` — nothing here is hand-typed or faked. It's the same breaker trip at trade #423, the same -$12,863 vs $9,512, the same hash-chained audit log, just baked into static serverless functions instead of read from disk on each request.

**What this is NOT:** the live mode (`node src/cli.js live`, real Bitget prices). Vercel serverless functions spin up per-request and don't stay alive between requests, so there's no way to run a continuous polling loop here. This site is a fixed, point-in-time mirror of one demo run — refreshing the page shows the same breaker trip every time, by design. If you want a public, always-on live version, that needs a small persistent host instead (Railway, Render, Fly.io — all have free tiers).

## Deploying

1. Push this `site/` folder (and `scripts/`) to your GitHub repo, alongside everything else.
2. Go to vercel.com → **Add New → Project** → import your repo.
3. When asked for **Root Directory**, set it to `site`.
4. Deploy. No other config needed — Vercel auto-detects the root `index.html` as the static entry point and `api/*.js` as serverless functions.

## Updating it after a fresh demo run

If you re-run `npm run demo` and want the deployed site to reflect the new run:

```bash
node scripts/generate-site-data.mjs
git add site/
git commit -m "Update site data from latest demo run"
git push
```

Vercel will redeploy automatically on the push.

## Honesty note

This was built and structurally tested (each `api/*.js` handler was executed locally and confirmed to return the correct, real data) in an environment that couldn't actually reach vercel.com to do a live deployment test. The file layout follows Vercel's standard zero-config convention exactly, but **load the URL yourself once it's deployed** to confirm before relying on it for a demo — same caveat as the live Bitget feed, for the same reason.
