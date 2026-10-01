import {
  CODE_REVIEW_MODEL, DIMENSIONS, type Answer, type CandidateAssessment,
  type CodeReviewReport, type CoverageStatus, type Dimension, type EvidenceRequest,
  type Observation, type PlanningDependencies, type ReviewPlan, type Source,
} from "./types.js";
import { clone, digest, freeze, integer, keys, oneOf, text } from "./data.js";
import { questionId } from "./questions.js";
import { groundSpans } from "./plan.js";
import { parseResponse } from "./parse.js";

export function checkObservation(value: unknown, plan: ReviewPlan, source: Source): Observation {
  const o = keys(clone(value), ["packetHash", "source", "latencyMs", "dispatched",
    "cachedFromSnapshot", "result", "failure"], "observation");
  const packet = plan.packets.find(p => p.hash === o.packetHash);
  if (!packet || o.source !== source) throw Error("Observation provenance mismatch");
  if (typeof o.latencyMs !== "number" || !Number.isFinite(o.latencyMs) || o.latencyMs < 0)
    throw Error("Invalid latency");
  if (typeof o.dispatched !== "boolean") throw Error("Missing dispatch provenance");
  if (o.cachedFromSnapshot !== null) {
    if (typeof o.cachedFromSnapshot !== "string" || !/^[a-f0-9]{64}$/.test(o.cachedFromSnapshot)
      || o.dispatched || o.failure !== null) throw Error("Invalid cache provenance");
  }
  if ((o.result === null) === (o.failure === null)) throw Error("Observation must contain one result or failure");
  if (o.failure !== null) oneOf(o.failure, ["egress_denied", "egress_error", "timeout", "cancelled",
    "transport_error", "malformed_response", "stale_snapshot", "budget_exhausted"], "failure");
  if (o.failure === null && !o.dispatched && o.cachedFromSnapshot === null)
    throw Error("Successful observation has no origin");
  const result = o.result === null ? null : parseResponse(o.result, packet, plan.policy.budget.maxResponseBytes);
  return freeze({ ...o, result } as unknown as Observation);
}

function mass(a: Answer, option: string): number {
  if (a.type !== "choice") throw Error("Expected Choice");
  return a.probabilities[option] ?? 0;
}
function yes(a: Answer): number {
  if (a.type !== "noul") throw Error("Expected Noul");
  return a.noul;
}
function selected(a: Answer, ids: Set<string>): string | null {
  return a.type === "choice" && ids.has(a.choice) ? a.choice : null;
}

/** Deterministic evidence reducer. Never calls decide(), emits a verdict, or executes anything. */
export function aggregateReview(
  plan: ReviewPlan, values: readonly Observation[], source: Source,
  sha256: PlanningDependencies["sha256"], relatedReceiptRef: string | null = null,
): CodeReviewReport {
  oneOf(source, ["mock", "jev"], "source");
  if (relatedReceiptRef !== null) text(relatedReceiptRef, "receipt reference");
  const observations = values.map(o => checkObservation(o, plan, source));
  if (new Set(observations.map(o => o.packetHash)).size !== observations.length)
    throw Error("Duplicate observation for a packet");
  const byPacket = new Map(observations.map(o => [o.packetHash, o]));
  const evidence = groundSpans(plan.input, { sha256 });
  const evidenceIds = new Set(evidence.map(s => s.id));
  const assessments: CandidateAssessment[] = [];
  const evidenceRequests: EvidenceRequest[] = [];
  const t = plan.policy.thresholds;
  for (const c of plan.candidates) {
    const packet = plan.packets.find(p => p.candidateIds.includes(c.id));
    const observation = packet ? byPacket.get(packet.hash) : undefined;
    let answers: Record<Dimension, Answer> | null = null;
    let status: CandidateAssessment["status"] = "unresolved";
    let reason = "No complete observation is available for this candidate.";
    let evidenceSpanId: string | null = null;
    let counterSpanId: string | null = null;
    if (observation?.result) {
      answers = Object.fromEntries(DIMENSIONS.map(d => [d, observation.result!.answers[questionId(c.id, d)]!])) as Record<Dimension, Answer>;
      evidenceSpanId = selected(answers.evidence, evidenceIds);
      counterSpanId = selected(answers.counterevidence, evidenceIds);
      const support = yes(answers.support);
      const contradiction = yes(answers.contradiction);
      const sufficient = mass(answers.context, "sufficient") >= t.context;
      if (support >= t.support && contradiction >= t.contradiction) {
        reason = "Support and counterevidence assessments conflict; do not multiply probabilities.";
      } else if (mass(answers.context, "not_applicable") >= t.context && support <= 1 - t.support) {
        status = "not_applicable"; reason = "The applicability assessment does not support this obligation here.";
      } else if (!sufficient) {
        reason = "Relevant context is missing or applicability is uncertain.";
      } else if (support >= t.support && contradiction <= 1 - t.contradiction && evidenceSpanId) {
        status = "supported"; reason = "The claim is semantically supported by a source-grounded span; not reproduced.";
      } else if (contradiction >= t.contradiction && support <= 1 - t.support && counterSpanId) {
        status = "contradicted"; reason = "Supplied counterevidence defeats the claim under this question set.";
      } else if (support <= 1 - t.support && contradiction <= 1 - t.contradiction) {
        status = "not_supported"; reason = "Sufficient supplied context did not support this claim; this is not proof of correctness.";
      } else {
        reason = "The assessments or selected source references do not establish a supported or contradicted claim.";
      }
    }
    const entry = plan.coverage.find(e => e.unitId === c.unitId && e.obligation === c.obligation)!;
    const active = entry.status !== "excluded_by_policy" && entry.status !== "not_applicable";
    if (active && ((status === "unresolved" && observation?.result)
      || (status === "supported" && answers && mass(answers.introduced, "unresolved") > 0.5))) {
      evidenceRequests.push({ candidateId: c.id, unitId: c.unitId, obligation: c.obligation,
        reason: status === "supported" ? "Before/after lineage remains unresolved." : reason,
        selectors: c.missingContext.length ? [...c.missingContext]
          : [`unit:${c.unitId}/obligation:${c.obligation}/relevant-contract-and-callers`] });
    }
    assessments.push({ candidateId: c.id, unitId: c.unitId, obligation: c.obligation, claim: c.claim,
      origin: c.origin, status, evidenceSpanId, counterSpanId, answers,
      evidenceLevel: status === "supported" ? "semantically_supported"
        : evidenceSpanId || counterSpanId ? "source_grounded" : "unresolved", reason });
  }
  const coverage = plan.coverage.map(entry => {
    if (["budget_exhausted", "not_applicable", "excluded_by_policy"].includes(entry.status)) return { ...entry };
    const packets = plan.packets.filter(p => p.candidateIds.some(c => entry.candidateIds.includes(c)));
    const incomplete = packets.find(p => !byPacket.get(p.hash)?.result);
    if (incomplete) {
      const failure = byPacket.get(incomplete.hash)?.failure;
      const status: CoverageStatus = failure === "egress_denied" || failure === "egress_error" ? "excluded_by_policy"
        : failure === "budget_exhausted" ? "budget_exhausted"
        : failure === "stale_snapshot" ? "missing_context" : "provider_unavailable";
      return { ...entry, status, reason: failure ?? "No observation was recorded for a planned packet." };
    }
    const relevant = assessments.filter(a => entry.candidateIds.includes(a.candidateId));
    if (relevant.some(a => a.status === "unresolved")
      || evidenceRequests.some(r => r.unitId === entry.unitId && r.obligation === entry.obligation))
      return { ...entry, status: "missing_context" as const, reason: "Some candidate claims or lineage remain unresolved." };
    return { ...entry, status: "assessed" as const, reason: "All scheduled candidate panels were assessed; not a correctness guarantee." };
  });
  const findings = assessments.filter(a => a.status === "supported");
  const edges: CodeReviewReport["edges"] = assessments.map(a => ({ from: `candidate:${a.candidateId}`,
    to: `unit:${a.unitId}`, relation: "concerns" }));
  for (const a of assessments) {
    if (a.status === "supported" && a.evidenceSpanId)
      edges.push({ from: `span:${a.evidenceSpanId}`, to: `candidate:${a.candidateId}`, relation: "supports" });
    if (a.status === "contradicted" && a.counterSpanId)
      edges.push({ from: `span:${a.counterSpanId}`, to: `candidate:${a.candidateId}`, relation: "contradicts" });
  }
  const dispatched = observations.filter(o => o.dispatched);
  const measurements = {
    plannedRequests: plan.packets.length, dispatchedRequests: dispatched.length,
    cacheHits: observations.filter(o => o.cachedFromSnapshot !== null).length,
    failedRequests: observations.filter(o => o.failure !== null).length,
    totalLatencyMs: observations.reduce((s, o) => s + o.latencyMs, 0),
    estimatedInputTokens: plan.packets.reduce((s, p) => s + p.inputTokenEstimate, 0),
    actualInputTokens: dispatched.reduce((s, o) => s + (o.result?.usage.input_tokens ?? 0), 0),
    actualOutputTokens: dispatched.reduce((s, o) => s + (o.result?.usage.output_tokens ?? 0), 0),
    unknownUsageRequests: dispatched.filter(o => !o.result).length,
  };
  for (const n of [measurements.actualInputTokens, measurements.actualOutputTokens])
    integer(n, 0, Number.MAX_SAFE_INTEGER, "total usage");
  const body = { schemaVersion: 1 as const, snapshotHash: plan.snapshotHash, policyHash: plan.policyHash,
    taskHash: plan.taskHash, planHash: plan.planHash, questionVersion: plan.questionVersion,
    model: CODE_REVIEW_MODEL, source, relatedReceiptRef,
    status: coverage.every(e => ["assessed", "not_applicable"].includes(e.status)) ? "complete" as const : "incomplete" as const,
    assessments, findings, evidence, edges, coverage, evidenceRequests, measurements };
  return freeze({ ...body, reportHash: digest(body, sha256) });
}
