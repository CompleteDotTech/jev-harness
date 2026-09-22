/** Optional Node audit adapter. No filesystem, network, clock, or execution. */
import { createHash } from "node:crypto";
import { decide, decideBase, type Decision } from "../contract/decide";
import { dataRecord } from "../contract/input";
import { JEV_MODEL, REVIEW_QUESTION_IDS, REVIEW_QUESTION_SET_VERSION, type JevSource, type Receipt } from "../contract/types";

export const AUDIT_POLICY_VERSION = "review-invariants-v1";
export interface EvidenceBinding {
  policyVersion: typeof AUDIT_POLICY_VERSION;
  /** Immutable revision of the decision implementation, supplied by the host. */
  decisionRevision: string;
  threshold: number;
  questionSetVersion: number;
  requestedModel: string;
  source: JevSource | "none";
  workspace: { task: string; files: Record<string, string> };
  /** Exact serialized request after host validation, before transport. */
  requestBody: string | null;
}
export interface BoundReceipt {
  bindingVersion: 1;
  receipt: Receipt;
  binding: EvidenceBinding;
  integrity: { algorithm: "sha256"; digest: string };
}
export type ReplayResult =
  | { ok: true; decision: Decision }
  | { ok: false; errors: string[] };

/** Deterministic bounded encoding of JSON data; reject silently lossy values. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  let nodes = 0;
  function encode(v: unknown, depth: number): string {
    if (++nodes > 100_000 || depth > 64) throw Error("Audit JSON exceeds structural limits.");
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "string") {
      if (v.length > 2_000_000) throw Error("Audit string exceeds size limit.");
      return JSON.stringify(v);
    }
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (!v || typeof v !== "object") throw Error("Audit input must be lossless JSON data.");
    if (active.has(v)) throw Error("Cyclic audit input.");
    active.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (v.length > 100_000 || Reflect.ownKeys(v).length !== v.length + 1)
        throw Error("Sparse or decorated audit array.");
      const items: string[] = [];
      for (let i = 0; i < v.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
        if (!descriptor || !("value" in descriptor)) throw Error("Invalid audit array entry.");
        items.push(encode(descriptor.value, depth + 1));
      }
      result = `[${items.join(",")}]`;
    } else {
      const record = dataRecord(v);
      if (!record) throw Error("Audit object must contain plain data properties.");
      result = `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${encode(record[k], depth + 1)}`).join(",")}}`;
    }
    active.delete(v);
    if (result.length > 2_000_000) throw Error("Audit JSON exceeds size limit.");
    return result;
  }
  return encode(value, 0);
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = dataRecord(value);
  if (!record) throw Error(`Malformed ${label}.`);
  return record;
}
function requireStrings(value: unknown, label: string): void {
  if (!Array.isArray(value) || !Array.from(value).every(v => typeof v === "string"))
    throw Error(`Malformed ${label}.`);
}

function auditDecision(receiptInput: unknown, bindingInput: unknown): Decision {
  const receipt = requireRecord(receiptInput, "receipt");
  const binding = requireRecord(bindingInput, "binding");
  if (binding.policyVersion !== AUDIT_POLICY_VERSION ||
      typeof binding.decisionRevision !== "string" || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(binding.decisionRevision) ||
      binding.questionSetVersion !== REVIEW_QUESTION_SET_VERSION || binding.requestedModel !== JEV_MODEL ||
      typeof binding.threshold !== "number" || !Number.isFinite(binding.threshold) || binding.threshold < 0.5 || binding.threshold > 1 ||
      !["jev", "mock", "none"].includes(String(binding.source))) throw Error("Unsupported audit policy or provenance.");
  const workspace = requireRecord(binding.workspace, "workspace");
  const files = requireRecord(workspace.files, "workspace files");
  if (typeof workspace.task !== "string" || !Object.values(files).every(v => typeof v === "string")) throw Error("Malformed workspace snapshot.");
  if (receipt.schemaVersion !== 1 || !["base", "plus_jev"].includes(String(receipt.mode)) ||
      !["good", "bad"].includes(String(receipt.arm)) || typeof receipt.fixtureId !== "string" ||
      typeof receipt.proposer !== "string" || typeof receipt.at !== "string" ||
      !Number.isFinite(Date.parse(receipt.at))) throw Error("Malformed receipt metadata.");
  const proposal = requireRecord(receipt.proposal, "proposal");
  if (!["read_file", "propose_patch"].includes(String(proposal.tool)) || typeof proposal.path !== "string" ||
      typeof proposal.rationale !== "string" || (proposal.tool === "propose_patch" && typeof proposal.patch !== "string") ||
      (proposal.tool === "read_file" && Object.hasOwn(proposal, "patch"))) throw Error("Malformed proposal.");
  requireStrings(proposal.evidence, "proposal evidence");
  const validation = requireRecord(receipt.validation, "validation");
  if (typeof validation.ok !== "boolean") throw Error("Malformed validation flag.");
  requireStrings(validation.errors, "validation errors");
  if (!validation.ok && receipt.jev !== null) throw Error("Rejected validation must not retain a review.");
  if (receipt.mode === "base" && receipt.jev !== null) throw Error("Base receipts cannot contain a review.");
  if (receipt.jev === null) {
    if (binding.source !== "none" || binding.requestBody !== null) throw Error("Unreviewed receipt has review provenance.");
  } else {
    const jev = requireRecord(receipt.jev, "review");
    if (jev.model !== binding.requestedModel || jev.source !== binding.source || binding.source === "none") throw Error("Model/source mismatch.");
    if (typeof binding.requestBody !== "string") throw Error("Reviewed receipt needs its exact request body.");
    const request = requireRecord(JSON.parse(binding.requestBody), "request");
    const state = requireRecord(request.state, "request state");
    const questions = requireRecord(request.questions, "request questions");
    if (request.model !== binding.requestedModel || !same(Object.keys(questions).sort(), [...REVIEW_QUESTION_IDS].sort()) ||
        state.task !== workspace.task || !same(state.files, files) || !same(state.proposal, proposal))
      throw Error("Request does not match its bound task, files, proposal, or question IDs.");
  }
  const decision = receipt.mode === "base" ? decideBase(validation) : decide(validation, receipt.jev, binding.threshold);
  const execution = requireRecord(receipt.execution, "execution record");
  const status = decision.verdict === "permit" || decision.verdict === "proposal_only" ? "recorded_pending" : "withheld";
  if (receipt.verdict !== decision.verdict || receipt.reason !== decision.reason ||
      execution.applied !== false || execution.status !== status || typeof execution.note !== "string")
    throw Error("Receipt decision/execution record does not replay.");
  return decision;
}

/** Bind a host-built v1 receipt; does not persist, authenticate, or authorize it. */
export function createBoundReceipt(receipt: Receipt, binding: EvidenceBinding): BoundReceipt {
  const payload = JSON.parse(canonicalJson({ bindingVersion: 1, receipt, binding }));
  auditDecision(payload.receipt, payload.binding);
  return { ...payload, integrity: { algorithm: "sha256", digest: digest(payload) } } as BoundReceipt;
}

/** Expected binding must come from trusted current host state, not the receipt. */
export function replayBoundReceipt(input: unknown, expected: EvidenceBinding): ReplayResult {
  try {
    const envelope = requireRecord(JSON.parse(canonicalJson(input)), "bound receipt");
    if (envelope.bindingVersion !== 1) throw Error("Unsupported binding version.");
    const integrity = requireRecord(envelope.integrity, "integrity");
    const payload = { bindingVersion: envelope.bindingVersion, receipt: envelope.receipt, binding: envelope.binding };
    if (integrity.algorithm !== "sha256" || typeof integrity.digest !== "string" || integrity.digest !== digest(payload))
      throw Error("Receipt digest mismatch.");
    if (!same(envelope.binding, expected)) throw Error("Current policy, provenance, request, or workspace does not match the recorded binding.");
    return { ok: true, decision: auditDecision(envelope.receipt, envelope.binding) };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "Receipt replay failed."] };
  }
}
