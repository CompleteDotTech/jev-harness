import type { CodeReviewReport, PlanningDependencies, ReviewTrace } from "./types.js";
import { canonical, clone, keys, oneOf, text } from "./data.js";
import { planReview } from "./plan.js";
import { aggregateReview } from "./aggregate.js";

/** Reconstructs plan and report offline. Hash integrity is not a signature or host identity. */
export function replayReview(value: unknown, deps: PlanningDependencies): CodeReviewReport {
  const t = keys(clone(value), ["schemaVersion", "plan", "observations", "source", "relatedReceiptRef", "reportHash"], "trace");
  if (t.schemaVersion !== 1 || !Array.isArray(t.observations)) throw Error("Unsupported trace");
  oneOf(t.source, ["mock", "jev"], "trace source");
  text(t.reportHash, "report hash");
  const trace = t as unknown as ReviewTrace;
  const rebuilt = planReview(trace.plan.input, trace.plan.policy, deps);
  if (canonical(rebuilt) !== canonical(trace.plan)) throw Error("Trace plan or evidence has changed");
  const report = aggregateReview(rebuilt, trace.observations, trace.source, deps.sha256, trace.relatedReceiptRef);
  if (report.reportHash !== trace.reportHash) throw Error("Trace report has changed");
  return report;
}

export interface DifferentialFinding {
  candidateId: string;
  change: "newly_supported" | "no_longer_supported" | "persistent" | "unresolved" | "neither_supported";
}
/** Matched stable candidate IDs only. These are observational differences, not causal proof. */
export function compareReviews(before: CodeReviewReport, after: CodeReviewReport): DifferentialFinding[] {
  for (const key of ["taskHash", "policyHash", "questionVersion", "model", "source"] as const)
    if (before[key] !== after[key]) throw Error(`Incomparable review ${key}`);
  const ids = [...new Set([...before.assessments, ...after.assessments].map(a => a.candidateId))].sort();
  return ids.map(candidateId => {
    const a = before.assessments.find(x => x.candidateId === candidateId);
    const b = after.assessments.find(x => x.candidateId === candidateId);
    if (!a || !b || a.claim !== b.claim || a.unitId !== b.unitId || a.obligation !== b.obligation
      || a.status === "unresolved" || b.status === "unresolved") return { candidateId, change: "unresolved" };
    const was = a.status === "supported", now = b.status === "supported";
    return { candidateId, change: was && now ? "persistent" : was ? "no_longer_supported"
      : now ? "newly_supported" : "neither_supported" };
  });
}
