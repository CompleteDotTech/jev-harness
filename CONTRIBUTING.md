# Contributing

This is an independent community harness for TypeSafe AI's Jev. Useful contributions include a new synthetic fixture category, a clearer question wording (with a version bump), a reproducible surprising verdict, or a host adapter kept outside `src/contract/`.

Read [README.md](README.md) for the contract and [AGENTS.md](AGENTS.md) for boundaries. Keep changes focused; do not bundle dependency upgrades, provider transports, or new execution authority into a fixture or documentation fix.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

Tests run offline. Nothing here needs a TypeSafe API key.

## Pull requests

- One concern per PR. Say what verdicts changed and why.
- New fixtures are original synthetic content with no secrets and no operational attack steps; instruction-trap fixtures stay harmless.
- A measured claim links the run that produced it. One run is a signal, not a calibration.
- Commits are signed.
