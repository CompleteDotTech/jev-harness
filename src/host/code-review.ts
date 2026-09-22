/** Host adapter: injected transport only. No HTTP client, credentials, file access or execution. */
import { createHash } from "node:crypto";
import {
  type CacheEntry, type FailureCode, type Observation, type Packet,
  type Payload, type PlanningDependencies, type ReviewResult, type Source,
} from "../code-review/types.js";
import { clone, freeze, integer, keys, oneOf, text } from "../code-review/data.js";
import { planReview } from "../code-review/plan.js";
import { parseResponse } from "../code-review/parse.js";
import { aggregateReview } from "../code-review/aggregate.js";
import { DEFAULT_REVIEW_POLICY } from "../code-review/validate.js";

/** Conservative demonstration accounting, not the model tokenizer or measured usage. */
export const nodePlanningDependencies: PlanningDependencies = {
  sha256: s => createHash("sha256").update(s, "utf8").digest("hex"),
  countTokens: s => new TextEncoder().encode(s).length,
  counterVersion: "utf8-byte-estimate/1",
};
export interface ReviewCache {
  get(key: string): Promise<unknown>;
  set(key: string, entry: CacheEntry): Promise<void>;
}
export interface HostReviewOptions {
  source: Source;
  dataClass: "synthetic" | "repository";
  policy?: unknown;
  dependencies?: PlanningDependencies;
  transport(payload: Payload, signal: AbortSignal): Promise<unknown>;
  allowEgress(request: { source: Source; snapshotHash: string; packetHash: string; payload: Payload }): Promise<boolean>;
  currentSnapshotHash?: () => Promise<string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  cache?: ReviewCache;
  relatedReceiptRef?: string;
}
class BoundaryFailure extends Error {
  constructor(readonly code: "timeout" | "cancelled") { super(code); }
}
async function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number, external?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => { controller.abort(); reject(new BoundaryFailure("cancelled")); };
        if (external?.aborted) { abort(); return; }
        external?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new BoundaryFailure("timeout")); }, timeoutMs);
      }),
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new BoundaryFailure("cancelled");
        return fn(controller.signal);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  }
}
function cached(value: unknown, packet: Packet, source: Source, maxBytes: number): CacheEntry {
  const e = keys(clone(value), ["schemaVersion", "packetHash", "source", "observedSnapshotHash", "response"], "cache");
  if (e.schemaVersion !== 1 || e.packetHash !== packet.hash || e.source !== source
    || typeof e.observedSnapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(e.observedSnapshotHash))
    throw Error("Cache provenance mismatch");
  const response = parseResponse(e.response, packet, maxBytes);
  return { schemaVersion: 1, packetHash: packet.hash, source,
    observedSnapshotHash: e.observedSnapshotHash, response };
}

/** Shadow-only orchestration. A result is never translated into a v1 verdict or host permission. */
export async function runCodeReview(input: unknown, options: HostReviewOptions): Promise<ReviewResult> {
  oneOf(options.source, ["mock", "jev"], "source");
  oneOf(options.dataClass, ["synthetic", "repository"], "data class");
  if (options.source === "mock" && options.dataClass !== "synthetic")
    throw Error("Mock runs require host-declared synthetic input");
  if (options.source === "jev" && !options.currentSnapshotHash)
    throw Error("Live review requires a host freshness callback");
  const timeoutMs = options.timeoutMs ?? 15000;
  integer(timeoutMs, 1, 300000, "timeout");
  const deps = options.dependencies ?? nodePlanningDependencies;
  const plan = planReview(input, options.policy ?? DEFAULT_REVIEW_POLICY, deps);
  const observations: Observation[] = [];
  const limit = plan.policy.budget;
  let spent = 0, stale = false;
  const fresh = async () => !options.currentSnapshotHash
    || await bounded(() => options.currentSnapshotHash!(), timeoutMs, options.signal) === plan.snapshotHash;
  for (const packet of plan.packets) {
    let failure: FailureCode | null = null;
    let result: Observation["result"] = null;
    let cachedFromSnapshot: string | null = null;
    let dispatched = false;
    const start = performance.now();
    try {
      if (options.signal?.aborted) throw new BoundaryFailure("cancelled");
      if (stale || !await fresh()) { stale = true; failure = "stale_snapshot"; }
      if (!failure) {
        try {
          const allowed = await bounded(() => options.allowEgress({ source: options.source,
            snapshotHash: plan.snapshotHash, packetHash: packet.hash, payload: packet.payload }), timeoutMs, options.signal);
          if (allowed !== true) failure = "egress_denied";
        } catch (error) {
          if (error instanceof BoundaryFailure) throw error;
          failure = "egress_error";
        }
      }
      if (!failure && options.cache) {
        try {
          const value = await bounded(() => options.cache!.get(packet.hash), timeoutMs, options.signal);
          if (value !== undefined && value !== null) {
            const hit = cached(value, packet, options.source, limit.maxResponseBytes);
            result = hit.response; cachedFromSnapshot = hit.observedSnapshotHash;
          }
        } catch (error) {
          if (error instanceof BoundaryFailure) throw error;
          // Corrupt/missing cache is a miss, never evidence or permission.
        }
      }
      if (!failure && !result && spent + packet.inputTokenEstimate > limit.maxTotalInputTokens)
        failure = "budget_exhausted";
      if (!failure && !result) {
        dispatched = true;
        const raw = await bounded(signal => options.transport(packet.payload, signal), timeoutMs, options.signal);
        try { result = parseResponse(raw, packet, limit.maxResponseBytes); }
        catch { failure = "malformed_response"; }
      }
      if (!failure && !await fresh()) { stale = true; failure = "stale_snapshot"; result = null; cachedFromSnapshot = null; }
    } catch (error) {
      failure = error instanceof BoundaryFailure ? error.code : "transport_error";
      result = null; cachedFromSnapshot = null;
    }
    if (dispatched) spent += result?.usage.input_tokens ?? packet.inputTokenEstimate;
    observations.push({ packetHash: packet.hash, source: options.source,
      latencyMs: Math.max(0, performance.now() - start), dispatched, cachedFromSnapshot, result, failure });
  }
  // A change observed after any packet invalidates the entire snapshot report, including cache hits.
  try { if (!await fresh()) stale = true; } catch { stale = true; }
  if (stale) {
    for (const o of observations) { o.result = null; o.failure = "stale_snapshot"; o.cachedFromSnapshot = null; }
  }
  // Write only after the final snapshot check. Cache storage is a host-owned optimization.
  if (!stale && options.cache) {
    for (const o of observations) {
      if (!o.result || o.cachedFromSnapshot) continue;
      try {
        await bounded(() => options.cache!.set(o.packetHash, { schemaVersion: 1,
          packetHash: o.packetHash, source: o.source, observedSnapshotHash: plan.snapshotHash,
          response: o.result! }), timeoutMs, options.signal);
      } catch { /* A cache write failure does not erase an already observed model response. */ }
    }
  }
  // Cache I/O may also outlive the snapshot; check again before publishing the report.
  try { if (!await fresh()) stale = true; } catch { stale = true; }
  if (stale) {
    for (const o of observations) { o.result = null; o.failure = "stale_snapshot"; o.cachedFromSnapshot = null; }
  }
  const receiptRef = options.relatedReceiptRef ?? null;
  const report = aggregateReview(plan, observations, options.source, deps.sha256, receiptRef);
  return freeze({ report, trace: { schemaVersion: 1, plan, observations: clone(observations),
    source: options.source, relatedReceiptRef: receiptRef, reportHash: report.reportHash } });
}

export interface ReviewToolHost {
  resolveSnapshot(ref: string): Promise<unknown>;
  resolvePolicy(ref: string): Promise<unknown>;
  optionsForSnapshot(ref: string): HostReviewOptions;
}
/** Only opaque references cross the agent-facing tool boundary; host registries resolve policy. */
export function createCodeReviewTool(host: ReviewToolHost) {
  return {
    name: "review_change" as const,
    description: "Collect shadow code-review evidence for a frozen snapshot; never authorizes an action.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["snapshot_ref", "review_policy_ref"],
      properties: { snapshot_ref: { type: "string" }, review_policy_ref: { type: "string" } } },
    async run(args: unknown) {
      const r = keys(clone(args), ["snapshot_ref", "review_policy_ref"], "tool arguments");
      text(r.snapshot_ref, "snapshot ref"); text(r.review_policy_ref, "policy ref");
      const options = host.optionsForSnapshot(r.snapshot_ref);
      const timeout = options.timeoutMs ?? 15000;
      integer(timeout, 1, 300000, "timeout");
      const input = await bounded(() => host.resolveSnapshot(r.snapshot_ref as string), timeout, options.signal);
      const policy = await bounded(() => host.resolvePolicy(r.review_policy_ref as string), timeout, options.signal);
      const { report } = await runCodeReview(input, { ...options, policy });
      return report; // Raw traces stay with the host, not the proposing agent.
    },
  };
}
