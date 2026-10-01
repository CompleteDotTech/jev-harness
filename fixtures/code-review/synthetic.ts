/** Original synthetic text, never executed. Expected labels are deliberately external to snapshots. */
import {
  CODE_REVIEW_MODEL, type Answer, type Payload, type SnapshotInput, type WireResponse,
} from "../../src/code-review/types.js";

export function syntheticSnapshot(): SnapshotInput {
  const before = ["export function debit(balance: number, amount: number) {",
    "  if (amount < 0) throw new Error('negative amount');", "  return balance - amount;", "}"].join("\n");
  const after = ["export function debit(balance: number, amount: number) {",
    "  return balance - amount;", "}"].join("\n");
  return { task: "Simplify the ledger helper while preserving rejection of negative debit amounts.",
    baseRevision: "synthetic-base", headRevision: "synthetic-head",
    diff: "--- a/src/ledger.ts\n+++ b/src/ledger.ts\n@@ -1,4 +1,3 @@\n export function debit(balance: number, amount: number) {\n-  if (amount < 0) throw new Error('negative amount');\n   return balance - amount;\n }",
    files: [{ id: "baseFile", path: "src/ledger.ts", side: "base", text: before },
      { id: "headFile", path: "src/ledger.ts", side: "head", text: after }],
    spans: [{ id: "beforeSpan", fileId: "baseFile", startLine: 1, endLine: 4, quote: before },
      { id: "afterSpan", fileId: "headFile", startLine: 1, endLine: 3, quote: after }],
    units: [{ id: "debit", spanIds: ["beforeSpan", "afterSpan"], exclusions: [] }],
    candidates: [{ id: "negativeDebit", unitId: "debit", obligation: "requirement",
      claim: "The proposed helper accepts negative debit amounts despite the explicit rejection requirement.",
      spanIds: ["afterSpan"], counterSpanIds: ["beforeSpan"], missingContext: [], origin: "llm" }] };
}
export type MockJudgment = "supported" | "contradicted" | "conflict" | "missing_context" | "not_supported";
/** Scripted distributions for protocol tests only. Never described as Jev measurements. */
export function mockResponse(payload: Payload, judgments: Record<string, MockJudgment> = {}): WireResponse {
  const answers: Record<string, Answer> = {};
  for (const [qid, q] of Object.entries(payload.questions)) {
    const split = qid.lastIndexOf(":");
    const candidateId = qid.slice(0, split), dimension = qid.slice(split + 1);
    const judgment = judgments[candidateId] ?? "not_supported";
    const positive = judgment === "supported" || judgment === "conflict";
    const contrary = judgment === "contradicted" || judgment === "conflict";
    if (q.type === "noul") {
      answers[qid] = { type: "noul", noul: (dimension === "support" ? positive : contrary) ? 0.99 : 0.01 };
    } else if (q.type === "choice") {
      let choice = "none";
      if (dimension === "context") choice = judgment === "missing_context" ? "missing_context" : "sufficient";
      if (dimension === "introduced") choice = positive ? "introduced" : "not_defect";
      if (dimension === "test_relevance") choice = "no_test";
      if (dimension === "evidence" && positive) choice = payload.state.spans.find(s => s.side === "head")!.id;
      if (dimension === "counterevidence" && contrary) choice = payload.state.spans.find(s => s.side === "base")!.id;
      const probabilities = Object.fromEntries(Object.keys(q.criteria).map(k => [k, Number(k === choice)]));
      answers[qid] = { type: "choice", choice, probabilities, confidence: 1 };
    } else {
      answers[qid] = { type: "score", score: 0,
        legend: Object.fromEntries(q.criteria.map((v, i) => [String(i), v])),
        probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), Number(i === 0)])), confidence: 1 };
    }
  }
  return { model: CODE_REVIEW_MODEL, answers, usage: { input_tokens: 100, output_tokens: Object.keys(answers).length * 8 } };
}
