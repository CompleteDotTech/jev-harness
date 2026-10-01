// Separate entry point: no changes to src/index.ts or the four-question gate.
export * from "./types.js";
export { DEFAULT_REVIEW_POLICY, validatePolicy, validateSnapshot } from "./validate.js";
export { canonical, digest } from "./data.js";
export { CATALOG, buildQuestions, questionId } from "./questions.js";
export { planReview, groundSpans } from "./plan.js";
export { parseResponse } from "./parse.js";
export { aggregateReview } from "./aggregate.js";
export { replayReview, compareReviews } from "./replay.js";
export { evaluateReviews, evaluatePairedReviews, rowFromReport } from "./evaluation.js";
export type { EvaluationManifest, EvaluationRow, EvaluationCase, EvaluationArm, Prediction, ArmMetrics } from "./evaluation.js";
export { bindReproductionWitnesses } from "./witness.js";
export type { ReproductionWitness } from "./witness.js";
