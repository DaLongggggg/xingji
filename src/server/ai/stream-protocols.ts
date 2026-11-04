/**
 * 流式事件契约（服务端）。
 *
 * 上游 SSE 的分帧与三协议 payload 解析已由 Vercel AI SDK（ai@7）承担，
 * 本文件只保留服务端 → 客户端的传输契约：
 * - 客户端用 NDJSON（一行一事件）读取 `/api/ai/generate` 的流式分支；
 * - 事件形状 `WorkbenchStreamEvent` 与客户端共用一份（features/ai/stream-events）；
 * - 硬规则不变：**恰好一个终止事件**，失败也以 error + done 收束。
 */

import { createNdjsonFramer, type WorkbenchStreamEvent } from "@/features/ai/stream-events";

export type { WorkbenchStreamEvent };
export { createNdjsonFramer };
