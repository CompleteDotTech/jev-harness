import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REVIEW_POLICY, aggregateReview, parseResponse, planReview, type Observation, type WireResponse,
} from "../src/code-review/index.js";
import { nodePlanningDependencies as deps } from "../src/host/code-review.js";
import { mockResponse, syntheticSnapshot, type MockJudgment } from "../fixtures/code-review/synthetic.js";
const plan = () => planReview(syntheticSnapshot(), DEFAULT_REVIEW_POLICY, deps);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function observations(judgments: Record<string, MockJudgment> = {}): { p: ReturnType<typeof plan>; observations: Observation[] } {
  const p = plan();
  return { p, observations: p.packets.map(packet => ({ packetHash: packet.hash, source: "mock",
    latencyMs: 1, dispatched: true, cachedFromSnapshot: null, result: mockResponse(packet.payload, judgments), failure: null })) };
}

test("strict parser preserves all three typed answer distributions", () => {
  const p = plan().packets[0]!;
  assert.deepEqual(parseResponse(mockResponse(p.payload), p, 2000000), mockResponse(p.payload));
});
for (const [name, mutate] of [
  ["unexpected model", (r: WireResponse) => { (r as unknown as {model: string}).model = "jev-latest"; }],
  ["missing answer", (r: WireResponse) => { delete r.answers[Object.keys(r.answers)[0]!]; }],
  ["extra answer", (r: WireResponse) => { r.answers.extra = { type: "noul", noul: 1 }; }],
  ["negative probability", (r: WireResponse) => { const a = Object.values(r.answers).find(a => a.type === "noul")!; if (a.type === "noul") a.noul = -0.01; }],
  ["non-finite probability", (r: WireResponse) => { const a = Object.values(r.answers).find(a => a.type === "noul")!; if (a.type === "noul") a.noul = NaN; }],
  ["unknown source option", (r: WireResponse) => { const a = Object.values(r.answers).find(a => a.type === "choice")!; if (a.type === "choice") a.choice = "inventedSpan"; }],
  ["non-maximal selection", (r: WireResponse) => { const a = Object.values(r.answers).find(a => a.type === "choice")!; if (a.type === "choice") a.choice = Object.keys(a.probabilities).find(k => a.probabilities[k] === 0)!; }],
  ["unnormalized distribution", (r: WireResponse) => { const a = Object.values(r.answers).find(a => a.type === "choice")!; if (a.type === "choice") a.probabilities[a.choice] = 0.4; }],
  ["forged score", (r: WireResponse) => { const a = Object.values(r.answers).find(a => a.type === "score")!; if (a.type === "score") a.score = 3; }],
  ["changed score legend", (r: WireResponse) => { const a = Object.values(r.answers).find(a => a.type === "score")!; if (a.type === "score") a.legend["0"] = "Different rubric"; }],
  ["out-of-range confidence", (r: WireResponse) => { const a = Object.values(r.answers).find(a => a.type === "choice")!; if (a.type === "choice") a.confidence = 2; }],
  ["negative usage", (r: WireResponse) => { r.usage.input_tokens = -1; }],
] as const) test(`parser rejects ${name}`, () => {
  const p = plan().packets[0]!;
  const r = mockResponse(p.payload); mutate(r);
  assert.throws(() => parseResponse(r, p, 2000000));
});
test("oversized and malformed response bodies fail closed", () => {
  const p = plan().packets[0]!;
  assert.throws(() => parseResponse(mockResponse(p.payload), p, 8));
  assert.throws(() => parseResponse("{not json}", p, 2000000));
});
test("provider confidence is not confused with selected-option probability", () => {
  const p = plan().packets[0]!;
  const r = mockResponse(p.payload);
  const a = Object.values(r.answers).find(a => a.type === "choice")!;
  if (a.type === "choice") a.confidence = 0.81;
  assert.deepEqual(parseResponse(r, p, 2000000), r);
});
test("supported candidate becomes an evidence-backed finding, not an authorization field", () => {
  const { p, observations: os } = observations({ negativeDebit: "supported" });
  const r = aggregateReview(p, os, "mock", deps.sha256, "receipt:example");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.candidateId, "negativeDebit");
  assert.equal(r.findings[0]!.evidenceLevel, "semantically_supported");
  assert.equal(r.findings[0]!.evidenceSpanId, "afterSpan");
  assert.equal(r.relatedReceiptRef, "receipt:example");
  assert.ok(r.edges.some(e => e.relation === "supports"));
  for (const field of ["verdict", "approved", "safe", "authorized", "execution"]) assert.equal(Object.hasOwn(r, field), false);
});
for (const judgment of ["conflict", "missing_context"] as const) test(`${judgment} produces unresolved evidence, not a clean review`, () => {
  const { p, observations: os } = observations({ negativeDebit: judgment });
  const r = aggregateReview(p, os, "mock", deps.sha256);
  assert.equal(r.findings.length, 0);
  assert.equal(r.assessments.find(a => a.candidateId === "negativeDebit")!.status, "unresolved");
  assert.equal(r.status, "incomplete"); assert.ok(r.evidenceRequests.length);
});
test("counterevidence is distinguishable from mere lack of support", () => {
  const { p, observations: os } = observations({ negativeDebit: "contradicted" });
  const r = aggregateReview(p, os, "mock", deps.sha256);
  assert.equal(r.assessments.find(a => a.candidateId === "negativeDebit")!.status, "contradicted");
  assert.ok(r.edges.some(e => e.relation === "contradicts"));
});
test("a confident unsupported source selector cannot manufacture grounding", () => {
  const { p, observations: os } = observations({ negativeDebit: "supported" });
  for (const o of os) {
    const a = o.result!.answers["negativeDebit:evidence"];
    if (a?.type === "choice") {
      a.choice = "none"; for (const k of Object.keys(a.probabilities)) a.probabilities[k] = Number(k === "none");
    }
  }
  assert.equal(aggregateReview(p, os, "mock", deps.sha256).findings.length, 0);
});
test("zero or partial observations do not imply that the remaining units are clean", () => {
  const { p, observations: os } = observations();
  const empty = aggregateReview(p, [], "mock", deps.sha256);
  assert.equal(empty.status, "incomplete"); assert.ok(empty.coverage.some(c => c.status === "provider_unavailable"));
  if (os.length > 1) assert.equal(aggregateReview(p, os.slice(0, 1), "mock", deps.sha256).status, "incomplete");
});
test("duplicate, foreign, contradictory and mixed-source observations are rejected", () => {
  const { p, observations: os } = observations();
  assert.throws(() => aggregateReview(p, [...os, os[0]!], "mock", deps.sha256));
  for (const changes of [ { packetHash: "foreign" }, { source: "jev" }, { failure: "transport_error" }, { dispatched: false } ]) {
    const modified = copy(os); Object.assign(modified[0]!, changes);
    assert.throws(() => aggregateReview(p, modified, "mock", deps.sha256));
  }
});
test("pre-existing lineage remains visible and unresolved lineage requests more evidence", () => {
  const { p, observations: os } = observations({ negativeDebit: "supported" });
  for (const o of os) {
    const a = o.result!.answers["negativeDebit:introduced"];
    if (a?.type === "choice") {
      a.choice = "unresolved"; for (const k of Object.keys(a.probabilities)) a.probabilities[k] = Number(k === "unresolved");
    }
  }
  const r = aggregateReview(p, os, "mock", deps.sha256);
  assert.equal(r.findings.length, 1); assert.equal(r.status, "incomplete");
  assert.ok(r.evidenceRequests.some(e => e.reason.includes("lineage")));
});
