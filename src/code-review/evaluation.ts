/** Offline, label-separated evaluation. No fixture labels enter a review payload. */
import type { CodeReviewReport } from "./types.js";
import { clone, integer, keys, list, oneOf, probability, text, unique } from "./data.js";

export interface EvaluationCase {
  id: string; family: string; split: "train" | "calibration" | "test";
  snapshotHash: string; labels: Record<string, boolean>;
}
export interface EvaluationArm {
  id: string; source: "mock" | "jev" | "external" | "deterministic";
  model: string; questionVersion: string; policyHash: string;
}
export interface EvaluationManifest { cases: EvaluationCase[]; arms: EvaluationArm[]; runs: string[] }
export interface Prediction {
  candidateId: string; status: "supported" | "not_supported" | "unresolved";
  probability: number | null;
}
export interface EvaluationRow {
  caseId: string; runId: string; arm: EvaluationArm; snapshotHash: string;
  predictions: Prediction[]; latencyMs: number;
  inputTokens: number | null; unknownUsageRequests: number;
  coverageAssessed: number; coverageTotal: number;
}
export interface ArmMetrics {
  arm: string; source: EvaluationArm["source"]; observations: number;
  truePositive: number; falsePositive: number; falseNegative: number; trueNegative: number;
  unresolved: number; precision: number | null; recall: number | null;
  precisionInterval95: [number, number] | null;
  brierScore: number | null; probabilityCoverage: number;
  meanLatencyMs: number; p95LatencyMs: number;
  knownInputTokens: number; rowsWithUnknownUsage: number;
  assessedCoverage: number | null; commentsPerCleanCase: number | null;
}

export function rowFromReport(report: CodeReviewReport, caseId: string, runId: string, armId: string): EvaluationRow {
  return { caseId, runId, snapshotHash: report.snapshotHash,
    arm: { id: armId, source: report.source, model: report.model,
      questionVersion: report.questionVersion, policyHash: report.policyHash },
    predictions: report.assessments.map(a => ({ candidateId: a.candidateId,
      status: a.status === "supported" ? "supported" : a.status === "unresolved" ? "unresolved" : "not_supported",
      probability: a.answers?.support.type === "noul" ? a.answers.support.noul : null })),
    latencyMs: report.measurements.totalLatencyMs,
    inputTokens: report.measurements.unknownUsageRequests ? null : report.measurements.actualInputTokens,
    unknownUsageRequests: report.measurements.unknownUsageRequests,
    coverageAssessed: report.coverage.filter(c => c.status === "assessed").length,
    coverageTotal: report.coverage.length };
}
function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.959963984540054, p = k / n, d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
function validateArm(value: unknown): EvaluationArm {
  const a = keys(value, ["id", "source", "model", "questionVersion", "policyHash"], "evaluation arm");
  for (const k of ["id", "model", "questionVersion", "policyHash"]) text(a[k], k);
  oneOf(a.source, ["mock", "jev", "external", "deterministic"], "arm source");
  return a as unknown as EvaluationArm;
}

/** Requires every declared case × run × arm. Missing predictions count as unresolved, not negatives. */
export function evaluateReviews(manifestValue: unknown, rowsValue: unknown): ArmMetrics[] {
  const m = keys(clone(manifestValue), ["cases", "arms", "runs"], "manifest");
  for (const k of ["cases", "arms", "runs"]) list(m[k], k);
  const manifest = m as unknown as EvaluationManifest;
  if (!manifest.cases.length || !manifest.arms.length || !manifest.runs.length) throw Error("Empty evaluation cohort");
  manifest.arms.forEach(validateArm); manifest.runs.forEach(r => text(r, "run"));
  unique(manifest.arms.map(a => a.id), "arms"); unique(manifest.runs, "runs");
  unique(manifest.cases.map(c => c.id), "cases");
  const familySplit = new Map<string, string>();
  for (const c of manifest.cases) {
    keys(c, ["id", "family", "split", "snapshotHash", "labels"], "case");
    for (const value of [c.id, c.family, c.snapshotHash]) text(value, "case identity");
    oneOf(c.split, ["train", "calibration", "test"], "split");
    if (familySplit.has(c.family) && familySplit.get(c.family) !== c.split) throw Error("Family leakage across splits");
    familySplit.set(c.family, c.split);
    const labels = keys(c.labels, Object.keys(c.labels), "labels");
    if (!Object.keys(labels).length || Object.values(labels).some(v => typeof v !== "boolean"))
      throw Error("Expected nonempty complete boolean candidate labels");
  }
  // Separate evaluation runs by split. No pooled train/test performance number.
  if (new Set(manifest.cases.map(c => c.split)).size !== 1) throw Error("Evaluate one split at a time");
  const copy: unknown = clone(rowsValue); list(copy, "evaluation rows");
  const rows = copy as EvaluationRow[];
  const seen = new Set<string>();
  for (const row of rows) {
    keys(row, ["caseId", "runId", "arm", "snapshotHash", "predictions", "latencyMs", "inputTokens",
      "unknownUsageRequests", "coverageAssessed", "coverageTotal"], "row");
    const arm = validateArm(row.arm);
    const expectedArm = manifest.arms.find(a => a.id === arm.id);
    if (!expectedArm || Object.keys(expectedArm).some(k => expectedArm[k as keyof EvaluationArm] !== arm[k as keyof EvaluationArm]))
      throw Error("Mixed treatment or unregistered arm");
    const c = manifest.cases.find(c => c.id === row.caseId);
    if (!c || c.snapshotHash !== row.snapshotHash || !manifest.runs.includes(row.runId)) throw Error("Row cohort mismatch");
    const tuple = JSON.stringify([row.caseId, row.runId, arm.id]);
    if (seen.has(tuple)) throw Error("Duplicate evaluation row"); seen.add(tuple);
    list(row.predictions, "predictions");
    unique(row.predictions.map(p => p.candidateId), "predictions");
    for (const p of row.predictions) {
      keys(p, ["candidateId", "status", "probability"], "prediction");
      if (!Object.hasOwn(c.labels, p.candidateId)) throw Error("Unlabeled prediction; extend labels before evaluation");
      oneOf(p.status, ["supported", "not_supported", "unresolved"], "prediction status");
      if (p.probability !== null) probability(p.probability, "prediction probability");
    }
    if (typeof row.latencyMs !== "number" || !Number.isFinite(row.latencyMs) || row.latencyMs < 0) throw Error("Invalid latency");
    if (row.inputTokens !== null) integer(row.inputTokens, 0, Number.MAX_SAFE_INTEGER, "tokens");
    integer(row.unknownUsageRequests, 0, Number.MAX_SAFE_INTEGER, "unknown usage");
    integer(row.coverageTotal, 0, Number.MAX_SAFE_INTEGER, "coverage total");
    integer(row.coverageAssessed, 0, row.coverageTotal, "assessed coverage");
  }
  if (seen.size !== manifest.cases.length * manifest.runs.length * manifest.arms.length)
    throw Error("Incomplete paired cohort");
  return manifest.arms.map(arm => {
    const cohort = rows.filter(r => r.arm.id === arm.id);
    let tp = 0, fp = 0, fn = 0, tn = 0, unresolved = 0, brier = 0, probabilities = 0, total = 0;
    let cleanCases = 0, cleanComments = 0;
    for (const row of cohort) {
      const c = manifest.cases.find(c => c.id === row.caseId)!;
      const clean = !Object.values(c.labels).some(Boolean);
      if (clean) cleanCases++;
      for (const [candidateId, positive] of Object.entries(c.labels)) {
        const prediction = row.predictions.find(p => p.candidateId === candidateId);
        const supported = prediction?.status === "supported";
        const unknown = !prediction || prediction.status === "unresolved";
        total++;
        if (unknown) unresolved++;
        if (positive) { if (supported) tp++; else fn++; }
        else if (supported) { fp++; if (clean) cleanComments++; }
        else if (!unknown) tn++;
        if (prediction?.probability !== null && prediction?.probability !== undefined) {
          brier += (prediction.probability - Number(positive)) ** 2; probabilities++;
        }
      }
    }
    const latencies = cohort.map(r => r.latencyMs).sort((a, b) => a - b);
    const coverageTotal = cohort.reduce((s, r) => s + r.coverageTotal, 0);
    return { arm: arm.id, source: arm.source, observations: cohort.length,
      truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn, unresolved,
      precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null,
      precisionInterval95: manifest.runs.length === 1
        && manifest.cases.every(c => Object.keys(c.labels).length === 1)
        && new Set(manifest.cases.map(c => c.family)).size === manifest.cases.length
        ? wilson(tp, tp + fp) : null, brierScore: probabilities ? brier / probabilities : null,
      probabilityCoverage: total ? probabilities / total : 0,
      meanLatencyMs: latencies.reduce((s, n) => s + n, 0) / latencies.length,
      p95LatencyMs: latencies[Math.ceil(0.95 * latencies.length) - 1]!,
      knownInputTokens: cohort.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      rowsWithUnknownUsage: cohort.filter(r => r.inputTokens === null || r.unknownUsageRequests > 0).length,
      assessedCoverage: coverageTotal ? cohort.reduce((s, r) => s + r.coverageAssessed, 0) / coverageTotal : null,
      commentsPerCleanCase: cleanCases ? cleanComments / cleanCases : null };
  });
}


/** Per-run and paired summaries. Repetitions are stability measurements, not independent samples. */
export function evaluatePairedReviews(manifest: EvaluationManifest, rows: EvaluationRow[]) {
  const pooled = evaluateReviews(manifest, rows); // Validate the complete cohort first.
  const byRun = manifest.runs.map(runId => ({ runId,
    metrics: evaluateReviews({ ...manifest, runs: [runId] }, rows.filter(r => r.runId === runId)) }));
  const paired: Array<{ left: string; right: string; pairs: number; meanFindingDelta: number;
    meanLatencyDeltaMs: number; discordantPredictions: number }> = [];
  for (let i = 0; i < manifest.arms.length; i++) for (let j = i + 1; j < manifest.arms.length; j++) {
    const left = manifest.arms[i]!.id, right = manifest.arms[j]!.id;
    let pairs = 0, findingDelta = 0, latencyDelta = 0, discordant = 0;
    for (const c of manifest.cases) for (const run of manifest.runs) {
      const a = rows.find(r => r.caseId === c.id && r.runId === run && r.arm.id === left)!;
      const b = rows.find(r => r.caseId === c.id && r.runId === run && r.arm.id === right)!;
      pairs++; latencyDelta += b.latencyMs - a.latencyMs;
      for (const id of Object.keys(c.labels)) {
        const x = a.predictions.find(p => p.candidateId === id)?.status ?? "unresolved";
        const y = b.predictions.find(p => p.candidateId === id)?.status ?? "unresolved";
        if (x !== y) discordant++;
        findingDelta += Number(y === "supported") - Number(x === "supported");
      }
    }
    paired.push({ left, right, pairs, meanFindingDelta: findingDelta / pairs,
      meanLatencyDeltaMs: latencyDelta / pairs, discordantPredictions: discordant });
  }
  const stability = manifest.arms.map(arm => {
    let stable = 0, total = 0;
    for (const c of manifest.cases) for (const id of Object.keys(c.labels)) {
      const statuses = manifest.runs.map(run => rows.find(r => r.caseId === c.id && r.runId === run
        && r.arm.id === arm.id)!.predictions.find(p => p.candidateId === id)?.status ?? "unresolved");
      total++; if (new Set(statuses).size === 1) stable++;
    }
    return { arm: arm.id, repeated: manifest.runs.length > 1, stable, total,
      rate: total ? stable / total : null };
  });
  return { pooled, byRun, paired, stability };
}
