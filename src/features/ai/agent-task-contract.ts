import { IMAGE_LIMITS } from "@/features/creation/creation-image-limits";
import type { ModelCallRecord } from "./stream-events";
/** Mobile task wire contract. JSON is canonical on both sides; original file bytes are hashed separately. */
export type TaskJson = null | boolean | number | string | TaskJson[] | { [key: string]: TaskJson };
export type AgentTaskKind = "workbench" | "organize_page" | "organize_captures" | "analyze_notebook" | "generate_page_metadata" | "organize_collection";
export type AgentTaskStatus = "queued" | "running" | "waiting_material" | "awaiting_ack" | "acked" | "failed" | "cancelled" | "interrupted" | "expired";
export type AgentTaskResource = { refId: string; kind: "text" | "image" | "memory" | "skill"; sha256: string; bytes: number; mime?: string };
export type AgentTaskConfigRef = { configId: string; revision: string; credentialId?: string };
export type AgentTaskCreateInput = {
  version: 1;
  chatSessionId: string;
  clientRequestId: string;
  kind: AgentTaskKind;
  config: { text: AgentTaskConfigRef; image?: AgentTaskConfigRef };
  manifest: { resources: AgentTaskResource[] };
  snapshot: { text?: string; resources?: { refId: string; text: string }[] };
  payload?: TaskJson;
};
export type AgentTaskFrozenBindings = { text: AgentTaskConfigRef & { credentialId: string }; image?: AgentTaskConfigRef & { credentialId: string } };
export type AgentTaskFile = { fileId: string; refId: string; sha256: string; bytes: number; mime: string; name: string };
export type AgentTaskResult = { version: 1; text?: string; proposals?: TaskJson[]; files: AgentTaskFile[]; calls?: ModelCallRecord[]; tools?: import("@/features/workbench/workbench-types").WorkbenchToolBlock[]; blocks?: import("@/features/workbench/workbench-types").WorkbenchMessageBlock[]; data?: TaskJson };
export type AgentTaskSummary = {
  id: string; userId: string; datasetId: string; chatSessionId: string; kind: AgentTaskKind; status: AgentTaskStatus;
  inputDigest: string; resultDigest: string | null; createdAt: number; updatedAt: number; expiresAt: number;
  errorCode: string | null; missingRefs: string[]; bindings: AgentTaskFrozenBindings;
};
export type AgentTaskEvent = { sequence: number; type: string; data: TaskJson; createdAt: number };
export const AGENT_TASK_LIMITS = { jsonBytes: 2 * 1024 * 1024, imageBytes: IMAGE_LIMITS.sourceBytes, maxImages: IMAGE_LIMITS.sourceImages, textBytes: 1024 * 1024, maxResources: 200, resultBytes: 4 * 1024 * 1024 } as const;
export const AGENT_TASK_TERMINAL = new Set<AgentTaskStatus>(["awaiting_ack", "acked", "failed", "cancelled", "interrupted", "expired"]);

/** Reject undefined, holes, nonfinite numbers, prototypes, cycles, and non-JSON values instead of silently changing identity. */
export function stableTaskJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || !item || ancestors.has(item)) throw new Error("TASK_JSON_INVALID");
    ancestors.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length) throw new Error("TASK_JSON_INVALID");
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) throw new Error("TASK_JSON_INVALID");
        for (let i = 0; i < item.length; i++) if (!Object.hasOwn(item, i)) throw new Error("TASK_JSON_INVALID");
        return `[${item.map(encode).join(",")}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("TASK_JSON_INVALID");
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
    } finally { ancestors.delete(item); }
  };
  return encode(value);
}

/** WebCrypto keeps the shared client contract free of Node-only imports. */
export async function taskSha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function agentTaskDigest(value: unknown): Promise<string> { return taskSha256(stableTaskJson(value)); }
