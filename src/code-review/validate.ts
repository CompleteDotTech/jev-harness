import {
  OBLIGATIONS, type ReviewPolicy, type SnapshotInput, type Obligation,
} from "./types.js";
import { canonical, clone, freeze, id, integer, keys, list, oneOf, probability, text, unique } from "./data.js";

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = freeze({
  version: "shadow/1", obligations: [...OBLIGATIONS], includeCandidates: true,
  thresholds: { support: 0.8, contradiction: 0.8, context: 0.8 },
  budget: { maxQuestionsPerRequest: 64, maxRequests: 8,
    maxInputTokensPerRequest: 60000, maxStateAndQuestionTokens: 30000,
    maxTotalInputTokens: 180000, maxResponseBytes: 2000000 },
});

export function validatePolicy(value: unknown): ReviewPolicy {
  const p = keys(clone(value), ["version", "obligations", "includeCandidates", "thresholds", "budget"], "policy");
  text(p.version, "policy version");
  list(p.obligations, "obligations");
  p.obligations.forEach(o => oneOf(o, OBLIGATIONS, "obligation"));
  unique(p.obligations as string[], "obligations");
  if (!p.obligations.length || typeof p.includeCandidates !== "boolean") throw Error("Invalid review profile");
  const t = keys(p.thresholds, ["support", "contradiction", "context"], "thresholds");
  for (const v of Object.values(t)) {
    probability(v, "threshold");
    if (v <= 0.5) throw Error("Review thresholds must exceed 0.5");
  }
  const b = keys(p.budget, ["maxQuestionsPerRequest", "maxRequests", "maxInputTokensPerRequest",
    "maxStateAndQuestionTokens", "maxTotalInputTokens", "maxResponseBytes"], "budget");
  integer(b.maxQuestionsPerRequest, 1, 4096, "question budget");
  integer(b.maxRequests, 0, 1024, "request budget");
  integer(b.maxInputTokensPerRequest, 1, 64000, "request context budget");
  integer(b.maxStateAndQuestionTokens, 1, 32000, "state and question budget");
  integer(b.maxTotalInputTokens, 0, 64000000, "total token budget");
  integer(b.maxResponseBytes, 1, 16000000, "response size budget");
  return freeze(p as unknown as ReviewPolicy);
}

function stringIds(value: unknown, label: string): string[] {
  list(value, label);
  value.forEach(v => id(v, label));
  unique(value as string[], label);
  return value as string[];
}
function path(value: unknown): void {
  text(value, "path");
  if (/^[\/]|[\\:\x00-\x1f]/.test(value) || value.split("/").some(p => !p || p === "." || p === ".."))
    throw Error("Expected a relative canonical path");
}

export function validateSnapshot(value: unknown): SnapshotInput {
  // Do not retain unbounded or executable input objects through an async boundary.
  const encoded = canonical(value);
  if (encoded.length > 8000000) throw Error("Snapshot exceeds local size limit");
  const s = keys(JSON.parse(encoded), ["task", "baseRevision", "headRevision", "diff",
    "files", "spans", "units", "candidates"], "snapshot");
  for (const k of ["task", "baseRevision", "headRevision"]) text(s[k], k);
  text(s.diff, "diff", true);
  for (const k of ["files", "spans", "units", "candidates"]) list(s[k], k);
  const files = (s.files as unknown[]).map(v => {
    const f = keys(v, ["id", "path", "side", "text"], "file");
    id(f.id, "file id"); path(f.path); oneOf(f.side, ["base", "head"], "side"); text(f.text, "file text", true);
    return f;
  });
  unique(files.map(f => f.id as string), "files");
  unique(files.map(f => `${f.side}:${f.path}`), "file paths");
  const fileMap = new Map(files.map(f => [f.id, f]));
  const spans = (s.spans as unknown[]).map(v => {
    const e = keys(v, ["id", "fileId", "startLine", "endLine", "quote"], "span");
    id(e.id, "span id"); id(e.fileId, "span file"); text(e.quote, "quote", true);
    const f = fileMap.get(e.fileId);
    if (!f) throw Error("Unknown span file");
    const lines = (f.text as string).split("\n");
    integer(e.startLine, 1, lines.length, "start line");
    integer(e.endLine, e.startLine, lines.length, "end line");
    if (lines.slice(e.startLine - 1, e.endLine).join("\n") !== e.quote)
      throw Error("Source quote does not match frozen file");
    return e;
  });
  unique(spans.map(e => e.id as string), "spans");
  const spanSet = new Set(spans.map(e => e.id));
  const refs = (value: unknown, label: string) => {
    const ids = stringIds(value, label);
    if (ids.some(i => !spanSet.has(i))) throw Error("Unknown evidence span");
    return ids;
  };
  const units = (s.units as unknown[]).map(v => {
    const u = keys(v, ["id", "spanIds", "exclusions"], "unit");
    id(u.id, "unit id");
    if (!refs(u.spanIds, "unit spans").length) throw Error("Unit requires source context");
    list(u.exclusions, "exclusions");
    const kinds: string[] = [];
    for (const raw of u.exclusions) {
      const e = keys(raw, ["obligation", "status", "reason"], "exclusion");
      oneOf(e.obligation, OBLIGATIONS, "obligation");
      oneOf(e.status, ["not_applicable", "excluded_by_policy"], "exclusion status");
      text(e.reason, "exclusion reason"); kinds.push(e.obligation);
    }
    unique(kinds, "exclusions");
    return u;
  });
  if (!units.length) throw Error("Review requires an explicit unit inventory");
  unique(units.map(u => u.id as string), "units");
  const unitSet = new Set(units.map(u => u.id));
  const candidates = (s.candidates as unknown[]).map(v => {
    const c = keys(v, ["id", "unitId", "obligation", "claim", "spanIds", "counterSpanIds",
      "missingContext", "origin"], "candidate");
    id(c.id, "candidate id");
    if (c.id.startsWith("catalog_")) throw Error("Candidate id uses catalog namespace");
    id(c.unitId, "candidate unit");
    if (!unitSet.has(c.unitId)) throw Error("Unknown candidate unit");
    oneOf(c.obligation, OBLIGATIONS, "obligation");
    text(c.claim, "claim");
    refs(c.spanIds, "candidate spans"); refs(c.counterSpanIds, "counter spans");
    list(c.missingContext, "missing context");
    c.missingContext.forEach(t => text(t, "context selector"));
    oneOf(c.origin, ["llm", "deterministic"], "candidate origin");
    return c;
  });
  unique(candidates.map(c => c.id as string), "candidates");
  // Cast only after checking the complete closed schema and every reference.
  return freeze(s as unknown as SnapshotInput);
}

export function obligationKey(unitId: string, obligation: Obligation): string {
  return `${unitId}/${obligation}`;
}
