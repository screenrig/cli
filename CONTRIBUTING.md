# Contributing

[AGENTS.md](AGENTS.md) names source ownership, build, vendoring and
verification. Run `npm run build`, then execute this checkout with
`node ./dist/bin.js`; installed plugins stay independent of it.

A profile file named `config.local-dev.json`, selected with `--config` or
`SCREENRIG_CONFIG`, targets the local edge (`http://api.screenrig.localhost:18880`).
Test with a separate profile, never a customer's. Releases are in
[RELEASING.md](RELEASING.md); report vulnerabilities per
[SECURITY.md](SECURITY.md).
