# Code-review sidecar: implementation verification

This records an **offline implementation check**, not a live Jev benchmark.
The source baseline was `102fb1765e6608797b27152fec669fe3b13e7ca0` on September 22, 2026.
The [machine-readable result](evidence/code-review-offline.json) binds the checked TypeScript files by Git blob SHA and records the original gate/scanner hashes.

## Actual results

| Check | Result |
| --- | --- |
| Offline strict typecheck | Passed across 23 TypeScript files, including examples and fixtures. |
| Offline Node test runner | 72 passed; 0 failed, cancelled, or skipped. |
| Unchanged original gate suite | All 9 original tests passed; original test and core blobs match the baseline. |
| New sidecar tests | 63 passed. |
| Synthetic shadow example | Source `mock`; one supported candidate; eight coverage entries. |
| Deterministic replay of example | Report hash matched. |
| Original dependency-free secret scanner | Passed on explicit changed working files. |

The tests exercise full and partial panels, forged references, malformed distributions, missing outputs, contradictory answers, instruction-like source text, egress denial, cancellation, timeout, stale snapshots (including changes during cache storage), cache provenance, replay tampering, differential comparisons, host-reported reproduction witnesses, and strict paired/repeated evaluation accounting.

## Environment and method

The available environment had Node **22.16.0** and a preinstalled TypeScript **5.8.3** compiler. The project requires pnpm **10.34.5** and pins TypeScript **7.0.2**, tsx **4.23.13**, and Node types **26.6.2**. Running `corepack pnpm --version` in the project attempted the correct pinned pnpm download but failed with `EAI_AGAIN` for `registry.npmjs.org`.

No dependency or lockfile was changed, no substitute package was installed, and no security check was disabled. The offline check called the available TypeScript compiler API with the project's strict options, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, plus the installed Node declarations. It then transpiled a separate temporary copy and ran:

```sh
node --test /mnt/data/jev-harness-check/tests/*.test.js
```

The example was separately transpiled as ESM and executed with Node. Its fake transport used scripted distributions. Tests never executed the synthetic source strings as code and never called Jev. The original secret scanner was run against explicit working-file paths; this is not a substitute for CI's full-history scan.

## Required before merge

Run the repository's unchanged, pinned workflow on the PR head:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm check:secrets
pnpm exec tsx examples/code-review-shadow.ts
```

The pinned toolchain, GitHub CI, full-history gitleaks, signed-commit requirement, and maintainer review remain separate release checks. Offline TypeScript 5.8.3 success is not a claim that the pinned TypeScript 7.0.2 workflow passed. A connector-created unsigned commit must not be merged contrary to the repository's signing requirement.

A live Jev pilot, independent semantic labels, real-repository egress review, and threshold calibration were **not performed**. Mock results establish plumbing and policy behavior only. The existing v1 decision table, model pin, questions, root exports, dependencies, workflows, and original tests are unchanged.
