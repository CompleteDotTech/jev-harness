/** Companion evidence contract. It does not import or extend the v1 gate. */
export const CODE_REVIEW_VERSION = 1 as const;
export const CODE_REVIEW_QUESTION_VERSION = "code-review/1" as const;
export const CODE_REVIEW_MODEL = "jev-1.13.0" as const;
export const OBLIGATIONS = Object.freeze([
  "requirement", "compatibility", "errors", "tests", "security",
  "lifecycle", "concurrency", "performance",
] as const);
export type Obligation = (typeof OBLIGATIONS)[number];
export type Source = "mock" | "jev";
export interface SourceFile { id: string; path: string; side: "base" | "head"; text: string }
export interface EvidenceSpan {
  id: string; fileId: string; startLine: number; endLine: number; quote: string;
}
export interface Exclusion {
  obligation: Obligation; status: "not_applicable" | "excluded_by_policy"; reason: string;
}
export interface ReviewUnit {
  id: string; spanIds: string[]; exclusions: Exclusion[];
}
export interface Candidate {
  id: string; unitId: string; obligation: Obligation; claim: string;
  spanIds: string[]; counterSpanIds: string[]; missingContext: string[];
  origin: "catalog" | "llm" | "deterministic";
}
/** Host-owned inventory. Unknown metadata keys are rejected, not sent to Jev. */
export interface SnapshotInput {
  task: string; baseRevision: string; headRevision: string; diff: string;
  files: SourceFile[]; spans: EvidenceSpan[]; units: ReviewUnit[];
  candidates: Candidate[];
}
export interface ReviewPolicy {
  version: string;
  obligations: Obligation[];
  includeCandidates: boolean;
  thresholds: { support: number; contradiction: number; context: number };
  budget: {
    maxQuestionsPerRequest: number; maxRequests: number;
    maxInputTokensPerRequest: number; maxStateAndQuestionTokens: number;
    maxTotalInputTokens: number; maxResponseBytes: number;
  };
}
/** Inject a cryptographic SHA-256 implementation and a versioned token counter. */
export interface PlanningDependencies {
  sha256(text: string): string;
  countTokens(text: string): number;
  counterVersion: string;
}
export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export const DIMENSIONS = Object.freeze([
  "context", "support", "contradiction", "introduced",
  "test_relevance", "impact", "evidence", "counterevidence",
] as const);
export type Dimension = (typeof DIMENSIONS)[number];
export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>;
      probabilities: Record<string, number>; confidence: number };
export interface WireResponse {
  model: typeof CODE_REVIEW_MODEL;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}
export interface GroundedSpan extends EvidenceSpan {
  path: string; side: "base" | "head"; fileHash: string;
}
export interface Payload {
  model: typeof CODE_REVIEW_MODEL;
  state: {
    notice: string; task: string; unitId: string;
    spans: GroundedSpan[]; candidates: Array<Omit<Candidate, "origin">>;
  };
  questions: Record<string, Question>;
}
export interface Packet {
  hash: string; unitId: string; candidateIds: string[];
  payload: Payload; inputTokenEstimate: number; stateQuestionTokenEstimate: number;
}
export type CoverageStatus = "assessed" | "not_applicable" | "missing_context"
  | "excluded_by_policy" | "budget_exhausted" | "provider_unavailable";
export interface CoverageEntry {
  unitId: string; obligation: Obligation; candidateIds: string[];
  status: CoverageStatus; reason: string;
}
export interface ReviewPlan {
  schemaVersion: 1; questionVersion: string; snapshotHash: string; policyHash: string;
  taskHash: string; planHash: string; counterVersion: string;
  input: SnapshotInput; policy: ReviewPolicy; candidates: Candidate[];
  packets: Packet[]; coverage: CoverageEntry[];
}
export type FailureCode = "egress_denied" | "egress_error" | "timeout" | "cancelled"
  | "transport_error" | "malformed_response" | "stale_snapshot" | "budget_exhausted";
export interface Observation {
  packetHash: string; source: Source; latencyMs: number; dispatched: boolean;
  cachedFromSnapshot: string | null;
  result: WireResponse | null; failure: FailureCode | null;
}
export type AssessmentStatus = "supported" | "contradicted" | "not_supported" | "unresolved" | "not_applicable";
export interface CandidateAssessment {
  candidateId: string; unitId: string; obligation: Obligation; claim: string;
  origin: Candidate["origin"]; status: AssessmentStatus;
  evidenceSpanId: string | null; counterSpanId: string | null;
  answers: Record<Dimension, Answer> | null;
  evidenceLevel: "source_grounded" | "semantically_supported" | "unresolved";
  reason: string;
}
export interface EvidenceRequest {
  candidateId: string; unitId: string; obligation: Obligation;
  reason: string; selectors: string[];
}
export interface EvidenceEdge {
  from: string; to: string;
  relation: "concerns" | "supports" | "contradicts";
}
export interface CodeReviewReport {
  schemaVersion: 1; reportHash: string; snapshotHash: string; policyHash: string;
  taskHash: string; planHash: string; questionVersion: string;
  model: typeof CODE_REVIEW_MODEL; source: Source;
  relatedReceiptRef: string | null;
  status: "complete" | "incomplete";
  assessments: CandidateAssessment[]; findings: CandidateAssessment[];
  evidence: GroundedSpan[]; edges: EvidenceEdge[];
  coverage: CoverageEntry[]; evidenceRequests: EvidenceRequest[];
  measurements: {
    plannedRequests: number; dispatchedRequests: number; cacheHits: number;
    failedRequests: number; totalLatencyMs: number;
    estimatedInputTokens: number; actualInputTokens: number; actualOutputTokens: number;
    unknownUsageRequests: number;
  };
}
export interface ReviewTrace {
  schemaVersion: 1; plan: ReviewPlan; observations: Observation[];
  source: Source; relatedReceiptRef: string | null; reportHash: string;
}
export interface CacheEntry {
  schemaVersion: 1; packetHash: string; source: Source;
  observedSnapshotHash: string; response: WireResponse;
}
export interface ReviewResult { report: CodeReviewReport; trace: ReviewTrace }
