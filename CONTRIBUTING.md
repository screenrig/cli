# CLI development

For maintainers testing this checkout. Read [AGENTS.md](AGENTS.md) for
source ownership and verification. Execute `node ./dist/bin.js` after building;
keep installed customer plugins independent of this checkout.

## Local configuration

When `config.local-dev.json`
exists in the normal config directory (`$XDG_CONFIG_HOME/screenrig` or
`~/.config/screenrig` on Unix; `%APPDATA%\screenrig` on Windows), the CLI uses
`http://api.screenrig.localhost:8088` by default. Otherwise the production
default is `https://api.screenrig.ai`. `SCREENRIG_API_URL` and `--api-url`
remain explicit overrides.

Use an explicit test configuration to avoid affecting a customer installation.
Do not print stored credentials. Release steps are in [RELEASING.md](RELEASING.md).
