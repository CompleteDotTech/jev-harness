# Code-review sidecar fixtures

`synthetic.ts` contains an original small ledger example and a protocol-only response factory. No fixture source is executed. It is separate from the existing v1 proposal-review fixture categories and does not replace the pending canonical playground fixture extraction.

Expected judgments are supplied to `mockResponse` outside the snapshot. The planner rejects `expected`, `arm`, and other undeclared fields in snapshot/candidate objects. Model payloads contain code and narrow questions, not evaluation labels or candidate-origin labels.

Tests mutate these original inputs to exercise missing context, counterevidence, conflicting support, injected instruction-like source, stale snapshots, transport errors, malformed outputs, resource budgets, and cache/replay integrity. Scripted distributions test the plumbing; they are not observations of Jev quality.

For real quality experiments, construct independently labeled good/bad changes with shared family IDs, hold families together in a single train/calibration/test split, freeze question/policy versions, declare all comparison arms and runs, and retain source/egress consent. The sidecar evaluation reports candidate-level rather than deduplicated defect-level metrics.
