import {
  CODE_REVIEW_MODEL, CODE_REVIEW_QUESTION_VERSION, CODE_REVIEW_VERSION, OBLIGATIONS,
  type Candidate, type CoverageEntry, type GroundedSpan, type Packet,
  type PlanningDependencies, type ReviewPlan, type SnapshotInput,
} from "./types.js";
import { canonical, digest, freeze, text, tokenCount } from "./data.js";
import { CATALOG, UNTRUSTED_NOTICE, buildQuestions } from "./questions.js";
import { DEFAULT_REVIEW_POLICY, validatePolicy, validateSnapshot } from "./validate.js";

export function groundSpans(input: SnapshotInput, deps: Pick<PlanningDependencies, "sha256">): GroundedSpan[] {
  const files = new Map(input.files.map(f => [f.id, f]));
  return input.spans.map(s => {
    const f = files.get(s.fileId)!;
    return { ...s, path: f.path, side: f.side, fileHash: digest(f, deps.sha256) };
  });
}

/** Pure greedy planner. A candidate's panel is atomic; no silent question/span truncation. */
export function planReview(
  inputValue: unknown, policyValue: unknown = DEFAULT_REVIEW_POLICY,
  deps: PlanningDependencies,
): ReviewPlan {
  text(deps.counterVersion, "counter version");
  const input = validateSnapshot(inputValue);
  const policy = validatePolicy(policyValue);
  const snapshotHash = digest(input, deps.sha256);
  const policyHash = digest(policy, deps.sha256);
  const grounded = groundSpans(input, deps);
  const spanMap = new Map(grounded.map(s => [s.id, s]));
  const candidates: Candidate[] = [];
  const packets: Packet[] = [];
  const coverage: CoverageEntry[] = [];
  let tokens = 0;
  for (const unit of input.units) {
    const scheduled: Candidate[] = [];
    const entries: CoverageEntry[] = [];
    for (const obligation of OBLIGATIONS) {
      const candidate: Candidate = {
        id: `catalog_${unit.id}_${obligation}`, unitId: unit.id, obligation,
        claim: CATALOG[obligation], spanIds: [...unit.spanIds], counterSpanIds: [],
        missingContext: [], origin: "catalog",
      };
      const panel = [candidate, ...(policy.includeCandidates
        ? input.candidates.filter(c => c.unitId === unit.id && c.obligation === obligation) : [])];
      candidates.push(...panel);
      const exclusion = unit.exclusions.find(e => e.obligation === obligation);
      const active = policy.obligations.includes(obligation) && !exclusion;
      const entry: CoverageEntry = {
        unitId: unit.id, obligation, candidateIds: panel.map(c => c.id),
        status: exclusion?.status ?? (active ? "missing_context" : "excluded_by_policy"),
        reason: exclusion?.reason ?? (active ? "Review pending." : "Outside the host-selected review profile."),
      };
      entries.push(entry);
      if (active) scheduled.push(...panel);
    }
    const makePacket = (batch: Candidate[]): Packet | null => {
      const ids = new Set([...unit.spanIds, ...batch.flatMap(c => [...c.spanIds, ...c.counterSpanIds])]);
      if (ids.size > 252) return null;
      const spans = [...ids].sort().map(i => spanMap.get(i)!);
      const questions = Object.assign({}, ...batch.map(c => buildQuestions(c, spans)));
      const payload = { model: CODE_REVIEW_MODEL,
        state: { notice: UNTRUSTED_NOTICE, task: input.task, unitId: unit.id,
          spans, candidates: batch.map(({ origin: _origin, ...c }) => c) }, questions };
      // The counter must include tokenizer/framing overhead. This extra reserve is explicit.
      const inputTokenEstimate = tokenCount(canonical(payload), deps) + 256;
      const stateQuestionTokenEstimate = tokenCount(canonical(payload.state), deps)
        + Math.max(...Object.values(questions).map(q => tokenCount(canonical(q), deps))) + 256;
      if (Object.keys(questions).length > policy.budget.maxQuestionsPerRequest
        || inputTokenEstimate > policy.budget.maxInputTokensPerRequest
        || stateQuestionTokenEstimate > policy.budget.maxStateAndQuestionTokens) return null;
      const hash = digest({ domain: "code-review-packet/1", policyHash,
        questionVersion: CODE_REVIEW_QUESTION_VERSION, counterVersion: deps.counterVersion, payload }, deps.sha256);
      return { hash, unitId: unit.id, candidateIds: batch.map(c => c.id), payload,
        inputTokenEstimate, stateQuestionTokenEstimate };
    };
    const omit = (batch: Candidate[]) => {
      for (const c of batch) {
        const entry = entries.find(e => e.obligation === c.obligation)!;
        entry.status = "budget_exhausted";
        entry.reason = "A full candidate panel or required context did not fit the host budget.";
      }
    };
    const emit = (batch: Candidate[]) => {
      if (!batch.length) return;
      const packet = makePacket(batch);
      if (!packet || packets.length >= policy.budget.maxRequests
        || tokens + packet.inputTokenEstimate > policy.budget.maxTotalInputTokens) { omit(batch); return; }
      packets.push(packet); tokens += packet.inputTokenEstimate;
    };
    let batch: Candidate[] = [];
    for (const c of scheduled) {
      if (makePacket([...batch, c])) { batch.push(c); continue; }
      emit(batch); batch = [];
      if (makePacket([c])) batch.push(c); else omit([c]);
    }
    emit(batch); coverage.push(...entries);
  }
  const body = { schemaVersion: CODE_REVIEW_VERSION, questionVersion: CODE_REVIEW_QUESTION_VERSION,
    snapshotHash, policyHash, taskHash: digest(input.task, deps.sha256),
    counterVersion: deps.counterVersion, input, policy, candidates, packets, coverage };
  return freeze({ ...body, planHash: digest(body, deps.sha256) });
}
