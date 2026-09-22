import type { CodeReviewReport, PlanningDependencies } from "./types.js";
import { clone, digest, freeze, keys, list, oneOf, text, unique } from "./data.js";

export interface ReproductionWitness {
  candidateId: string; snapshotHash: string; claimHash: string;
  runRef: string; artifactHash: string;
  outcome: "reproduced" | "not_reproduced" | "inconclusive";
}
/** Bind externally collected host evidence. This does not execute tests or authenticate the host. */
export function bindReproductionWitnesses(report: CodeReviewReport, value: unknown, sha256: PlanningDependencies["sha256"]) {
  const rows: unknown = clone(value); list(rows, "witnesses");
  const witnesses = rows.map(row => {
    const w = keys(row, ["candidateId", "snapshotHash", "claimHash", "runRef", "artifactHash", "outcome"], "witness");
    const a = report.assessments.find(a => a.candidateId === w.candidateId);
    if (!a || w.snapshotHash !== report.snapshotHash || w.claimHash !== digest(a.claim, sha256))
      throw Error("Witness is not bound to this exact claim and snapshot");
    text(w.runRef, "run reference");
    if (typeof w.artifactHash !== "string" || !/^[a-f0-9]{64}$/.test(w.artifactHash)) throw Error("Invalid artifact hash");
    oneOf(w.outcome, ["reproduced", "not_reproduced", "inconclusive"], "witness outcome");
    return w as unknown as ReproductionWitness;
  });
  unique(witnesses.map(w => JSON.stringify([w.candidateId, w.runRef])), "witnesses");
  const body = { schemaVersion: 1, reviewReportHash: report.reportHash,
    evidenceSource: "host_reported" as const, witnesses };
  return freeze({ ...body, bundleHash: digest(body, sha256) });
}
