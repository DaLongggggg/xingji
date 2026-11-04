/**
 * 流式事件的共享形状与客户端 NDJSON 分帧。
 *
 * 放在 `features/ai`（客户端可用）：服务端的协议解析与浏览器端的流式消费
 * 必须用同一份类型与同一种分帧实现，避免两边各写一份而漂移。
 */

/**
 * R4（§7.1）：单次调用的记录（模型或图片）。usage 缺失保持未知（不填零）；
 * 时长是实测 started/ended；不记录完整提示、Memory 文本或密钥。
 */
export type ModelCallRecord = {
  callId: string;
  stage: "search" | "plan" | "understand" | "design" | "image" | "describe" | "answer";
  configId?: string;
  /** 服务端实际发送的供应商模型 ID；缺失时不可用配置 ID 或显示名补猜。 */
  model?: string;
  startedAt: number;
  endedAt?: number;
  outcome?: "success" | "error" | "cancelled" | "timeout";
  usage?: { inputTokens?: number; outputTokens?: number };
  /**
   * 体量估算（§7.1，口径可辨）：textChars = 客户端输入字符数；
   * serverTextChars = 服务端组装消息的可统计文本字符（system + 资源正文 + 用户输入）。
   * 两者都是字符数，不是 token；缺失保持未知。
   */
  estimate?: { textChars?: number; serverTextChars?: number };
  /** R4：实际使用的知识资源（服务端回显；缺省 = 未使用或未知，不编造）。阶段B 起版本字段可选，以 digest 标识。 */
  resources?: { id: string; version?: string; digest?: string }[];
  /** 归属：图片执行的任务/项/尝试（文字调用缺省）。 */
  executionId?: string;
  itemId?: string;
  attemptId?: string;
};

/** 服务端与客户端共用的事件形状。 */
export type WorkbenchStreamEvent = (
  | { type: "call"; call: ModelCallRecord }
  /** 调用局部元信息：先报告服务端解析的 model，供应商回执可更新同一次调用。 */
  | { type: "model_meta"; model: string }
  | { type: "image_advice"; advice: import("@/features/workbench/workbench-types").ImageAdvice }
  /** R4：design_image_prompt 的流式首事件——本次实际采用的模式与资源版本（体量走 server_estimate）。 */
  | { type: "design_meta"; designMode: "skill" | "base"; resources: { id: string; version?: string; digest?: string }[] }
  | { type: "server_estimate"; textChars: number }
  | { type: "stage"; stage: "preparing" | "planning" | "thinking" | "tool" | "answering" | "waiting"; label: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string; source: "provider" }
  | { type: "tool_call"; id: string; name: string; title: string; argsDigest: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; truncated?: true;
      search?: import("./native-search-contract").NativeSearchResult }
  /** 工作台本地批量修图：单张成功后把附件立即放进当前助手消息。 */
  | { type: "image_result"; sourceId: string; attachment: { id: string; name: string; dataUrl: string } }
  | { type: "step"; index: number; limit: number }
  | { type: "notice"; level: "info" | "warn"; message: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "done"; reason: "stop" | "cancelled" | "limit" | "timeout" | "error" }
) & { sequence?: number };

/** 客户端 NDJSON 分帧：一行一事件，半行留在缓冲里。 */
export function createNdjsonFramer(): { push(chunk: string): WorkbenchStreamEvent[]; flush(): WorkbenchStreamEvent[] } {
  let buffer = "";
  const decode = (lines: string[]): WorkbenchStreamEvent[] => {
    const events: WorkbenchStreamEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as WorkbenchStreamEvent;
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") events.push(parsed);
      } catch {
        events.push({ type: "error", code: "STREAM_MALFORMED", message: "流式事件不是有效 JSON。", retryable: true });
      }
    }
    return events;
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      return decode(parts);
    },
    flush() {
      const rest = buffer;
      buffer = "";
      return decode(rest ? [rest] : []);
    }
  };
}
