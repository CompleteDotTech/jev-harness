# Security

This repository contains no credentials, no live transport, and no code path that executes a proposal. The attack surface is small, but not zero: a bug in `decide()` that turns an unfavorable answer into `permit`, a fixture that leaks something real, or a validator (once extracted) that lets a path escape its root would all matter.

## Reporting

**Report privately.** Use [GitHub private vulnerability reporting](https://github.com/TypeSafeAI/jev-harness/security/advisories/new) for anything that could cause a proposal to be treated as more trustworthy than it is. Do not open a public issue for it. Private reporting is enabled on this repository.

**Never post a key.** If you accidentally commit a TypeSafe API key or any other secret, rotate it first, then tell us. Rewriting history does not un-leak a key.

**Scope note.** Questions about the Jev model or the TypeSafe API itself belong with [TypeSafe AI's official channels](https://typesafe.ai). This is a community project and cannot act on those.

## What stops a secret from leaving

Four layers, from your laptop outward. None of them is a reason to skip the others.

| Layer | Where | What it does |
| --- | --- | --- |
| `pre-commit` hook | your machine (`.githooks/`, installed by `pnpm install`) | `scripts/check-secrets.mjs` blocks staged `.env` files and well-known key shapes with no dependencies; runs `gitleaks protect --staged` too if you have it (`brew install gitleaks`) |
| `.gitignore` | your machine | `.env`, `.env.*` (except `.env.example`), key files, competing lockfiles |
| CI `secret scan` job | every push and PR | the built-in check over all tracked files plus **gitleaks** (pinned release, checksum-verified) over full history; a hit fails the build |
| GitHub secret scanning + **push protection** | the remote | known provider tokens are rejected at push time before they land; alerts for anything that slips through |

Also on: Dependabot alerts and security updates, a `main` ruleset (signed commits required, no force-push, no deletion, linear history), read-only `GITHUB_TOKEN` in workflows, actions pinned to commit SHAs, `persist-credentials: false` on checkout.

Bypassing the hook with `--no-verify` is for false positives only. If the thing it caught is real, rotate it; hiding it in history is not a fix.
