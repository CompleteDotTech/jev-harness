import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REVIEW_POLICY, bindReproductionWitnesses, compareReviews, digest, evaluateReviews,
  evaluatePairedReviews, replayReview, rowFromReport, type EvaluationManifest, type EvaluationRow,
} from "../src/code-review/index.js";
import { nodePlanningDependencies as deps, runCodeReview } from "../src/host/code-review.js";
import { mockResponse, syntheticSnapshot, type MockJudgment } from "../fixtures/code-review/synthetic.js";
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const run = (judgments: Record<string, MockJudgment> = {}) => runCodeReview(syntheticSnapshot(), {
  source: "mock", dataClass: "synthetic", allowEgress: async () => true,
  transport: async payload => mockResponse(payload, judgments),
});

test("offline replay rejects source, question, policy, response and report tampering", async () => {
  const { trace } = await run({ negativeDebit: "supported" });
  const edits = [
    (t: typeof trace) => { t.plan.input.task += " changed"; },
    (t: typeof trace) => { t.plan.policy.thresholds.support = 0.9; },
    (t: typeof trace) => { const q = Object.values(t.plan.packets[0]!.payload.questions)[0]!; q.instructions = "changed"; },
    (t: typeof trace) => { t.observations[0]!.latencyMs += 1; },
    (t: typeof trace) => { t.reportHash = "0".repeat(64); },
    (t: typeof trace) => { t.observations.pop(); },
  ];
  for (const edit of edits) { const t = copy(trace); edit(t); assert.throws(() => replayReview(t, deps)); }
  assert.throws(() => replayReview(trace, { ...deps, counterVersion: "different-counter" }));
});
test("differential review reports observed support changes without subtracting probabilities", async () => {
  const before = (await run()).report;
  const after = (await run({ negativeDebit: "supported" })).report;
  assert.equal(compareReviews(before, after).find(d => d.candidateId === "negativeDebit")!.change, "newly_supported");
  assert.equal(compareReviews(after, before).find(d => d.candidateId === "negativeDebit")!.change, "no_longer_supported");
  assert.equal(compareReviews(after, after).find(d => d.candidateId === "negativeDebit")!.change, "persistent");
  const missing = (await run({ negativeDebit: "missing_context" })).report;
  assert.equal(compareReviews(missing, after).find(d => d.candidateId === "negativeDebit")!.change, "unresolved");
  const changed = copy(after); changed.taskHash = "different";
  assert.throws(() => compareReviews(before, changed));
});
test("reproduction witnesses are host-reported, claim-bound and do not rewrite semantic assessments", async () => {
  const { report } = await run({ negativeDebit: "supported" });
  const assessment = report.assessments.find(a => a.candidateId === "negativeDebit")!;
  const witness = { candidateId: assessment.candidateId, snapshotHash: report.snapshotHash,
    claimHash: digest(assessment.claim, deps.sha256), runRef: "host-test-run:example",
    artifactHash: "a".repeat(64), outcome: "reproduced" };
  const bundle = bindReproductionWitnesses(report, [witness], deps.sha256);
  assert.equal(bundle.evidenceSource, "host_reported");
  assert.equal(assessment.evidenceLevel, "semantically_supported");
  for (const patch of [{ snapshotHash: "old" }, { claimHash: "old" }, { candidateId: "absent" }])
    assert.throws(() => bindReproductionWitnesses(report, [{ ...witness, ...patch }], deps.sha256));
  assert.throws(() => bindReproductionWitnesses(report, [witness, witness], deps.sha256));
});
async function evaluation() {
  const r = (await run({ negativeDebit: "supported" })).report;
  const row = rowFromReport(r, "case-one", "run-one", "fixed-plus-candidates");
  const manifest: EvaluationManifest = { cases: [{ id: row.caseId, family: "ledger-family", split: "test",
    snapshotHash: r.snapshotHash, labels: Object.fromEntries(r.assessments.map(a => [a.candidateId, a.candidateId === "negativeDebit"])) }],
    arms: [row.arm], runs: [row.runId] };
  return { row, manifest };
}
test("candidate-level evaluator preserves labels outside model input and computes known synthetic counts", async () => {
  const { row, manifest } = await evaluation();
  const [m] = evaluateReviews(manifest, [row]);
  assert.equal(m!.truePositive, 1); assert.equal(m!.falsePositive, 0);
  assert.equal(m!.trueNegative, 8); assert.equal(m!.recall, 1);
  assert.equal(m!.source, "mock"); assert.ok(m!.brierScore !== null);
  assert.equal(m!.precisionInterval95, null); // Multiple correlated claims, no independent-sample CI.
});
test("missing predictions remain unresolved and positive omissions count against operational recall", async () => {
  const { row, manifest } = await evaluation(); row.predictions = [];
  const [m] = evaluateReviews(manifest, [row]);
  assert.equal(m!.unresolved, 9); assert.equal(m!.falseNegative, 1);
  assert.equal(m!.trueNegative, 0); assert.equal(m!.recall, 0); assert.equal(m!.precision, null);
});
test("evaluation refuses missing pairs, duplicate rows, mixed treatments and unlabeled claims", async () => {
  const { row, manifest } = await evaluation();
  assert.throws(() => evaluateReviews(manifest, []), /Incomplete/);
  assert.throws(() => evaluateReviews(manifest, [row, row]), /Duplicate/);
  const mixed = copy(row); mixed.arm.source = "jev";
  assert.throws(() => evaluateReviews(manifest, [mixed]), /Mixed/);
  const invented = copy(row); invented.predictions.push({ candidateId: "unknown", status: "supported", probability: 1 });
  assert.throws(() => evaluateReviews(manifest, [invented]), /Unlabeled/);
});
test("evaluation detects family leakage and never pools train/test splits", async () => {
  const { row, manifest } = await evaluation();
  manifest.cases.push({ ...copy(manifest.cases[0]!), id: "case-two", split: "train" });
  assert.throws(() => evaluateReviews(manifest, [row]), /leakage/);
  manifest.cases[1]!.family = "another-family";
  assert.throws(() => evaluateReviews(manifest, [row]), /one split/);
});
test("paired and repeated reports include exact discordance and stability, not independence claims", async () => {
  const { row, manifest } = await evaluation();
  manifest.arms.push({ ...row.arm, id: "comparison" }); manifest.runs.push("run-two");
  const rows: EvaluationRow[] = [];
  for (const arm of manifest.arms) for (const runId of manifest.runs) {
    const r = copy(row); r.arm = arm; r.runId = runId;
    if (arm.id === "comparison" && runId === "run-two") r.predictions.find(p => p.candidateId === "negativeDebit")!.status = "unresolved";
    rows.push(r);
  }
  const result = evaluatePairedReviews(manifest, rows);
  assert.equal(result.byRun.length, 2); assert.equal(result.paired[0]!.pairs, 2);
  assert.equal(result.paired[0]!.discordantPredictions, 1);
  assert.equal(result.stability[0]!.rate, 1);
  assert.ok(result.stability[1]!.rate! < 1);
});
test("unknown token usage is not mislabeled as a measured zero", async () => {
  const { row, manifest } = await evaluation(); row.inputTokens = null; row.unknownUsageRequests = 1;
  const [m] = evaluateReviews(manifest, [row]);
  assert.equal(m!.rowsWithUnknownUsage, 1); assert.equal(m!.knownInputTokens, 0);
});
