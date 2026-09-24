import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REVIEW_POLICY, planReview, replayReview, type CacheEntry, type ReviewPolicy,
} from "../src/code-review/index.js";
import {
  createCodeReviewTool, nodePlanningDependencies as deps, runCodeReview,
  type HostReviewOptions,
} from "../src/host/code-review.js";
import { mockResponse, syntheticSnapshot } from "../fixtures/code-review/synthetic.js";
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function options(extra: Partial<HostReviewOptions> = {}): HostReviewOptions {
  return { source: "mock", dataClass: "synthetic", allowEgress: async () => true,
    transport: async payload => mockResponse(payload, { negativeDebit: "supported" }), ...extra };
}

test("shadow host returns a replayable report with no live service or proposed-code execution", async () => {
  const result = await runCodeReview(syntheticSnapshot(), options());
  assert.equal(result.report.source, "mock");
  assert.equal(result.report.findings.length, 1);
  assert.deepEqual(replayReview(JSON.parse(JSON.stringify(result.trace)), deps), result.report);
  assert.equal(result.report.measurements.unknownUsageRequests, 0);
});
test("egress denial makes zero transport calls and records exclusions", async () => {
  let calls = 0;
  const result = await runCodeReview(syntheticSnapshot(), options({ allowEgress: async () => false,
    transport: async () => { calls++; throw Error("must not run"); } }));
  assert.equal(calls, 0); assert.equal(result.report.findings.length, 0);
  assert.equal(result.report.status, "incomplete");
  assert.ok(result.report.coverage.every(c => c.status === "excluded_by_policy"));
});
test("provider exceptions never leak their raw message into receipts", async () => {
  const result = await runCodeReview(syntheticSnapshot(), options({ transport: async () => { throw Error("private-provider-detail"); } }));
  assert.equal(JSON.stringify(result).includes("private-provider-detail"), false);
  assert.equal(result.report.findings.length, 0);
  assert.ok(result.report.measurements.unknownUsageRequests > 0);
});
test("a hung transport times out and the request signal is aborted", async () => {
  let aborted = 0;
  const result = await runCodeReview(syntheticSnapshot(), options({ timeoutMs: 5,
    transport: async (_, signal) => new Promise(() => { signal.addEventListener("abort", () => aborted++); }) }));
  assert.ok(aborted > 0);
  assert.ok(result.trace.observations.every(o => o.failure === "timeout"));
});
test("an already-cancelled review never calls transport", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const result = await runCodeReview(syntheticSnapshot(), options({ signal: controller.signal,
    transport: async payload => { calls++; return mockResponse(payload); } }));
  assert.equal(calls, 0); assert.equal(result.report.findings.length, 0);
  assert.ok(result.trace.observations.every(o => o.failure === "cancelled"));
});
test("malformed model responses are failures instead of usable partial answers", async () => {
  const result = await runCodeReview(syntheticSnapshot(), options({ transport: async payload => {
    const response = mockResponse(payload); delete response.answers[Object.keys(response.answers)[0]!]; return response;
  } }));
  assert.ok(result.trace.observations.every(o => o.failure === "malformed_response"));
  assert.equal(result.report.findings.length, 0);
});
test("changed snapshot invalidates every observation, including earlier successful packets", async () => {
  const input = syntheticSnapshot(); const hash = planReview(input, DEFAULT_REVIEW_POLICY, deps).snapshotHash;
  let checks = 0;
  const result = await runCodeReview(input, options({ currentSnapshotHash: async () => ++checks < 3 ? hash : "changed" }));
  assert.equal(result.report.findings.length, 0);
  assert.ok(result.trace.observations.every(o => o.failure === "stale_snapshot"));
});
test("live source requires explicit freshness; mock rejects repository data", async () => {
  await assert.rejects(runCodeReview(syntheticSnapshot(), options({ source: "jev" })), /freshness/);
  await assert.rejects(runCodeReview(syntheticSnapshot(), options({ dataClass: "repository" })), /synthetic/);
});
test("cache reuse is bound to payload, model, source and policy and does not rebill cached usage", async () => {
  const store = new Map<string, CacheEntry>(); let calls = 0;
  const settings = options({ cache: { get: async k => store.get(k), set: async (k, v) => { store.set(k, v); } },
    transport: async payload => { calls++; return mockResponse(payload); } });
  const first = await runCodeReview(syntheticSnapshot(), settings); const firstCalls = calls;
  const input = syntheticSnapshot(); input.files.push({ id: "unrelated", path: "src/other.ts", side: "head", text: "// independent" });
  const second = await runCodeReview(input, settings);
  assert.equal(calls, firstCalls); assert.equal(second.report.measurements.actualInputTokens, 0);
  assert.equal(second.report.measurements.cacheHits, firstCalls);
  assert.ok(second.trace.observations.every(o => o.cachedFromSnapshot === first.report.snapshotHash));
  assert.notEqual(first.report.snapshotHash, second.report.snapshotHash);
  assert.deepEqual(replayReview(second.trace, deps), second.report);
  input.task += " Additional requirement.";
  await runCodeReview(input, settings); assert.ok(calls > firstCalls);
});
test("corrupt and mock-origin cache entries cannot be promoted into live-source observations", async () => {
  const input = syntheticSnapshot(); const p = planReview(input, DEFAULT_REVIEW_POLICY, deps); let calls = 0;
  const result = await runCodeReview(input, options({ source: "jev", currentSnapshotHash: async () => p.snapshotHash,
    cache: { get: async k => ({ schemaVersion: 1, packetHash: k, source: "mock", observedSnapshotHash: p.snapshotHash,
      response: mockResponse(p.packets.find(p => p.hash === k)!.payload) }), set: async () => {} },
    transport: async payload => { calls++; return mockResponse(payload); } }));
  assert.ok(calls > 0); assert.equal(result.report.measurements.cacheHits, 0);
});
test("observed usage above the planned estimate stops subsequent dispatches", async () => {
  const p: ReviewPolicy = copy(DEFAULT_REVIEW_POLICY);
  p.budget.maxQuestionsPerRequest = 8; p.budget.maxRequests = 20; let calls = 0;
  const result = await runCodeReview(syntheticSnapshot(), options({ policy: p, transport: async payload => {
    calls++; const r = mockResponse(payload); r.usage.input_tokens = p.budget.maxTotalInputTokens + 1; return r;
  } }));
  assert.equal(calls, 1);
  assert.ok(result.report.coverage.some(c => c.status === "budget_exhausted"));
});
test("registry tool accepts references, rejects caller-selected policy overrides and does not return raw trace", async () => {
  const tool = createCodeReviewTool({ resolveSnapshot: async () => syntheticSnapshot(),
    resolvePolicy: async () => DEFAULT_REVIEW_POLICY, optionsForSnapshot: () => options() });
  assert.equal(tool.name, "review_change");
  const report = await tool.run({ snapshot_ref: "snapshot-one", review_policy_ref: "shadow-one" });
  assert.equal(report.source, "mock"); assert.equal(Object.hasOwn(report, "trace"), false);
  await assert.rejects(tool.run({ snapshot_ref: "x", review_policy_ref: "y", threshold: 0 }));
});

test("snapshot changes during cache storage invalidate the outgoing report", async () => {
  const input = syntheticSnapshot(); const hash = planReview(input, DEFAULT_REVIEW_POLICY, deps).snapshotHash;
  let changed = false;
  const result = await runCodeReview(input, options({ currentSnapshotHash: async () => changed ? "new-head" : hash,
    cache: { get: async () => undefined, set: async () => { changed = true; } } }));
  assert.equal(result.report.findings.length, 0);
  assert.ok(result.trace.observations.every(o => o.failure === "stale_snapshot"));
});
