/**
 * R1 图片执行契约（任务书 C1/C2/C3）：客户端与服务端共用的**语义合同**。
 *
 * 这里只有类型、预算常量与纯函数：没有 IO、没有 React、没有网络。
 * - `ImageTaskPlan`：一次图片任务按产物项固定的计划（不可变；重试不改含义）；
 * - `ImageAttemptIdentity` / 尝试状态：一次出站的独立身份与权威状态；
 * - 预算公式：两入口（自然语言 / 显式快捷）共用同一套执行预算。
 *
 * 服务端对每个出站请求自行计算摘要（不相信客户端自报），见
 * `src/server/ai/image-execution-store.ts`。
 */

import type { ImageOutputFormat } from "../creation/creation-image-rules";

/** 尝试状态（C2 的权威含义，由服务端尝试表持有；会话/工具块只是投影）。 */
export type ImageAttemptStatus =
  | "prepared" // 参数和任务快照已保存，尚未登记出站
  | "dispatched" // 已在本地登记即将出站；远端可能已经执行
  | "succeeded" // 图片响应已校验，产物或其已保存位置可确认
  | "failed" // 有明确失败证据（不保证供应商未计费）
  | "outcome_unknown"; // 出站后超时/断连/崩溃，不能判定远端结果

/** 一次图片出站的身份信封（§4.2）。新工作台执行必须携带；没有匿名分支。 */
export type ImageAttemptIdentity = {
  sessionId: string;
  messageId: string;
  executionId: string;
  itemId: string;
  attemptId: string;
  /** 用户发起新尝试时携带上一尝试 ID；首次省略。 */
  previousAttemptId?: string;
};

/** 实际出站的图片请求快照（C1.6）：一旦用于出站就不可改写。 */
export type ImagePromptSnapshot = {
  /** 实际发送的完整 prompt（含保留约束/风格合入后的最终文本）。 */
  prompt: string;
  size: string;
  quality: "low" | "medium" | "high";
  outputFormat?: ImageOutputFormat;
  /** 有序来源字节摘要（与计划来源顺序一致）。 */
  sourceDigests: string[];
  /** 服务端核定的制图配置指纹（不含凭据）。 */
  configDigest: string;
  /**
   * 修图源图出站时的转换记录（与 sourceDigests 同序；缺省 = 全部原字节直传，
   * 或旧会话未记录）。null 项表示该图未转换；只有实际发生降档/展平的图有条目。
   */
  sourceTransforms?: { index: number; reason: "byte-budget" | "alpha-flatten"; mime: string; width: number; height: number; background?: "#FFFFFF" }[];
};

/** 一次图片任务计划（C1）。`executionId/itemId` 由代码生成，模型不能指定。 */
export type ImageTaskPlan = {
  version: 1;
  executionId: string;
  /** 用户（或模型转述后的）本轮完整原始要求。 */
  originalRequest: string;
  mode: "edit" | "generate";
  sources: {
    sourceId: string;
    attachmentId: string;
    /** 此任务内从 1 开始；重试不改变。 */
    originalOrder: number;
    name: string;
    /** 来源字节摘要（解码后 sha256），用于绑定与恢复核对。 */
    sourceDigest: string;
  }[];
  items: {
    itemId: string;
    /** 本项使用的来源（edit 恰好一个；generate 0..9 个参考）。 */
    sourceIds: string[];
    /** 完整的本项要求，不依赖「上面那张」等指代。 */
    instruction: string;
  }[];
  config: {
    textConfigId: string;
    imageConfigId: string;
    /** 服务端核定的制图配置指纹；ID 相同但实际配置变化时出站会被拒绝。 */
    configDigest: string;
    size?: string;
    outputFormat?: ImageOutputFormat;
    style?: string;
    /**
     * R4：本任务选用的知识资源（计划创建时冻结）。重试沿用同一份——
     * 资源开关后续变化只会让显式请求报错，不会静默换方法。
     */
    skillIds?: string[];
  };
};

/** 会话内保存的尝试投影（客户端可见状态；权威在服务端尝试表）。 */
export type ImageAttemptProjection = {
  attemptId: string;
  itemId: string;
  attemptNo: number;
  previousAttemptId?: string;
  status: ImageAttemptStatus;
  /** 首次出站前保存；重试复用，提示设计尚未成功时才允许重新设计。 */
  promptSnapshot?: ImagePromptSnapshot;
  errorCode?: string;
  /** 成功后由服务端回执填写。 */
  artifactId?: string;
  artifactDigest?: string;
  /** 产物已写入会话附件并取得保存回执（artifactSaved 是独立事实）。 */
  delivered?: true;
  /** 本项设计实际采用的资源摘要（跨回合钉定；缺省 = 未使用/未知，不编造）。
   *  files = 该资源读取过的文件身份（含 references，跨回合变化检测）。 */
  skillResources?: { id: string; digest: string; files?: { path: string; digest: string }[] }[];
  /** 旧链（阶段B 前）的版本记录：仅为旧会话可读保留，不再写入。 */
  skillVersion?: string;
};

/**
 * 执行预算（C3）。`textRequestMs` 必须等于服务端网关单次上限
 * `GATEWAY_LIMITS.timeoutMs`（60 秒）——不另写一份供应商超时；
 * 一致性由 `image-execution-contract.test.ts` 断言。
 */
export const IMAGE_EXECUTION_BUDGET = {
  /** 现有 Gateway 单次上限（对话请求：理解 / 提示设计 / 结果说明 / 计划）。 */
  textRequestMs: 60_000,
  /** 现有图片单次上限（`IMAGE_LIMITS.timeoutMs`）。 */
  imageRequestMs: 600_000,
  /** 保存屏障的有界等待。 */
  saveBarrierMs: 10_000,
  /** 单个任务的产物项上限（与图片输入张数上限一致）。 */
  maxItems: 9
} as const;

/**
 * 整批执行期限上限：`N × (2Ttext + Timage + Tsave) + Ttext + Tsave`。
 * 这是**最大预算**而不是预计耗时；尾部的 `Ttext + Tsave` 覆盖整批结果说明。
 * 最多九项，因而有界。
 */
export function batchImageDeadlineMs(items: number): number {
  const count = Math.max(1, Math.min(IMAGE_EXECUTION_BUDGET.maxItems, Math.floor(items)));
  const { textRequestMs, imageRequestMs, saveBarrierMs } = IMAGE_EXECUTION_BUDGET;
  return count * (2 * textRequestMs + imageRequestMs + saveBarrierMs) + textRequestMs + saveBarrierMs;
}

/** 尝试出站的期限：单次图片上限之后留出终态落库的余量。 */
export const ATTEMPT_DEADLINE_SLACK_MS = 60_000;

/**
 * 尝试状态对**用户操作**的含义（C2）：
 * - `resumable`：已经出站且没有终态证据，先查询原尝试，不自动重新生成；
 * - `retryable`：明确失败，仅由用户发起新尝试；
 * - `inFlight`：登记出站后仍在期限内，显示处理中；
 * - `done`：已有产物（可能尚未进入会话）。
 */
export function attemptUserAction(status: ImageAttemptStatus): "resumable" | "retryable" | "inFlight" | "done" {
  if (status === "outcome_unknown") return "resumable";
  if (status === "failed") return "retryable";
  if (status === "dispatched") return "inFlight";
  return "done";
}
