import { CODE_REVIEW_MODEL, type Answer, type Packet, type WireResponse } from "./types.js";
import { canonical, freeze, integer, keys, probability, record } from "./data.js";

function distribution(value: unknown, options: string[]): Record<string, number> {
  const r = keys(value, options, "distribution");
  for (const p of Object.values(r)) probability(p, "distribution probability");
  const sum = Object.values(r).reduce<number>((s, p) => s + (p as number), 0);
  if (Math.abs(sum - 1) > 0.000001) throw Error("Distribution does not sum to one");
  return r as Record<string, number>;
}

/** Strict runtime boundary; never trusts provider-selected labels or weighted scores alone. */
export function parseResponse(value: unknown, packet: Packet, maxBytes: number): WireResponse {
  const json = typeof value === "string" ? value : canonical(value);
  // UTF-8 byte length without a host dependency. Surrogate handling follows JSON encoding.
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > maxBytes) throw Error("Response exceeds configured byte budget");
  const r = keys(JSON.parse(json), ["model", "answers", "usage"], "response");
  if (r.model !== CODE_REVIEW_MODEL) throw Error("Unexpected model revision");
  const raw = keys(r.answers, Object.keys(packet.payload.questions), "answers");
  const answers: Record<string, Answer> = {};
  for (const [qid, q] of Object.entries(packet.payload.questions)) {
    const a = record(raw[qid], "answer");
    if (a.type !== q.type) throw Error("Answer/question type mismatch");
    if (q.type === "noul") {
      keys(a, ["type", "noul"], "noul"); probability(a.noul, "noul");
      answers[qid] = { type: "noul", noul: a.noul };
    } else if (q.type === "choice") {
      keys(a, ["type", "choice", "probabilities", "confidence"], "choice");
      const probabilities = distribution(a.probabilities, Object.keys(q.criteria));
      probability(a.confidence, "choice confidence");
      if (typeof a.choice !== "string" || !Object.hasOwn(probabilities, a.choice)
        || probabilities[a.choice]! < Math.max(...Object.values(probabilities)))
        throw Error("Choice does not select a maximum-probability supplied option");
      // Provider confidence is retained, not equated to the selected probability.
      answers[qid] = { type: "choice", choice: a.choice, probabilities, confidence: a.confidence };
    } else {
      keys(a, ["type", "score", "legend", "probabilities", "confidence"], "score");
      const levels = q.criteria.map((_, i) => String(i));
      const probabilities = distribution(a.probabilities, levels);
      const legend = keys(a.legend, levels, "score legend");
      if (levels.some(k => legend[k] !== q.criteria[Number(k)])) throw Error("Score legend changed");
      probability(a.confidence, "score confidence");
      const expected = levels.reduce((s, k) => s + Number(k) * probabilities[k]!, 0);
      if (typeof a.score !== "number" || !Number.isFinite(a.score) || Math.abs(a.score - expected) > 0.000001)
        throw Error("Score is inconsistent with its distribution");
      answers[qid] = { type: "score", score: expected, legend: legend as Record<string, string>,
        probabilities, confidence: a.confidence };
    }
  }
  const usage = keys(r.usage, ["input_tokens", "output_tokens"], "usage");
  integer(usage.input_tokens, 0, Number.MAX_SAFE_INTEGER, "input tokens");
  integer(usage.output_tokens, 0, Number.MAX_SAFE_INTEGER, "output tokens");
  return freeze({ model: CODE_REVIEW_MODEL, answers,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } });
}
