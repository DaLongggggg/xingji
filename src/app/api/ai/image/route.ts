/**
 * P9-04：受控图片路由（Next.js App Router，仅 POST）；R1 起携带身份信封。
 *
 * 边界：
 * - 默认关闭：`XINGJI_AI_ENABLED=1` + AI 网关可用 + `XINGJI_AI_IMAGE_ENABLED=1`
 *   三者全部满足才继续；三道判定都在**任何配置解析与出站请求之前**；
 * - 客户端只提交受控配置 ID 与结构化参数，不能提交 baseUrl / apiKey；
 * - 未知字段一律拒绝（不静默忽略），请求体按字节流式限额；
 * - R1（§4.2）：新工作台执行必须带身份信封；在现有许可、配置、尺寸/字节校验后核对
 *   身份确属已保存计划，事务预留尝试与容量，确认持久化 `dispatched` 后才调用 Provider；
 * - 重复 POST：摘要不同 → `IMAGE_ATTEMPT_CONFLICT`；已成功 → 返回原产物或其会话引用；
 *   在途/未知 → 返回明确状态，零新的供应商请求；
 * - 提供方返回后先校验图片、持久化产物与终态，再响应客户端；
 * - 任何失败都返回明确 code + status，不伪造成功，也不回显密钥或出站请求头。
 */
import { createImageConfigStore, ImageConfigError, isImageRouteEnabled } from "@/server/ai/image-config";
import { AI_ENABLED_ENV, isAiExecutionEnabled, safeConfigDetail } from "@/server/ai/model-config";
import { requireBetaAccess } from "@/server/ai/session-http";
import { currentScopeEnv } from "@/server/ai/user-scope";
import {
  createImageProvider,
  IMAGE_LIMITS,
  IMAGE_SIZES,
  type ImageMode,
  type ImageQuality
} from "@/server/ai/image-provider";
import { decodedBase64Bytes, IMAGE_REQUEST_FIELDS } from "@/features/creation/creation-image-limits";
import { imageOutputFormats, type ImageOutputFormat } from "@/features/creation/creation-image-rules";
import type { ImageAttemptIdentity } from "@/features/ai/image-execution-contract";
import {
  ATTEMPT_DEADLINE_SLACK_MS,
  IMAGE_EXECUTION_BUDGET
} from "@/features/ai/image-execution-contract";
import {
  bytesDigest,
  ImageExecutionStoreError,
  registerDispatch,
  recordTerminal,
  requestDigest,
  type AttemptRow
} from "@/server/ai/image-execution-store";
import { openDatabase } from "@/server/ai/sqlite-db";
import { readSession, SESSION_LIMITS, SessionStoreError } from "@/server/ai/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 完整 JSON 请求体预算（含所有输入的 base64 膨胀），与前端共用同一份常量。 */
const MAX_BODY_BYTES = IMAGE_LIMITS.requestBodyBytes;

/** 请求体允许出现的字段：与客户端共用同一份清单（见 `IMAGE_REQUEST_FIELDS`）。 */
const ALLOWED_FIELDS = new Set<string>(IMAGE_REQUEST_FIELDS);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function fail(code: string, detail: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, code, detail, ...extra }, status);
}

/** 流式读取请求体，超过字节上限立即停止，不先全量读入。 */
async function readBodyWithinLimit(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  const body = request.body;
  if (!body) {
    const text = await request.text();
    return new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES ? null : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock?.();
  }
}

/** 配置异常 → HTTP 状态：端点/配置/密钥问题属于请求错误，整体关闭才是 503。 */
function statusForConfigError(error: ImageConfigError): number {
  return error.code === "IMAGE_DISABLED" ? 503 : 400;
}

type ImageRequestBody = {
  configId: string;
  mode: ImageMode;
  prompt: string;
  size: string;
  quality: ImageQuality;
  outputFormat?: ImageOutputFormat;
  /** 输入图：编辑恰好一张；生成 0..N 张（N>1 = 让模型用这几张图生成一张新图）。 */
  sourceImages?: { mime: string; base64: string }[];
  /** R1 身份信封：必填（没有可绕过尝试记录的匿名执行分支）。 */
  identity: ImageAttemptIdentity;
};

/** 规范 base64 编码长度：ceil 已包含尾部填充；实际文件字节还须单独复核。 */
function base64LengthLimit(sourceBytes: number): number {
  return Math.ceil(sourceBytes / 3) * 4;
}

/** 内部客户端发送规范 base64；拒绝 Buffer 会忽略的内嵌填充与其它字符。 */
function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length <= padding) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (index >= value.length - padding) {
      if (code !== 61) return false;
    } else if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  return true;
}

/** R1 身份信封的形状校验：字段齐全、非空、有长度上限。 */
function parseIdentity(value: unknown): ImageAttemptIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = (key: string, max: number): string | undefined => {
    const item = record[key];
    return typeof item === "string" && item.length > 0 && item.length <= max ? item : undefined;
  };
  const sessionId = id("sessionId", 120);
  const messageId = id("messageId", 120);
  const executionId = id("executionId", 120);
  const itemId = id("itemId", 120);
  const attemptId = id("attemptId", 120);
  if (!sessionId || !messageId || !executionId || !itemId || !attemptId) return undefined;
  const previous = record.previousAttemptId;
  if (previous !== undefined && (typeof previous !== "string" || previous.length === 0 || previous.length > 120)) {
    return undefined;
  }
  return {
    sessionId, messageId, executionId, itemId, attemptId,
    ...(typeof previous === "string" ? { previousAttemptId: previous } : {})
  };
}

/** 请求体结构校验；任何缺陷返回明确 code，绝不静默忽略字段。 */
function parseImageRequest(payload: unknown): ImageRequestBody | { code: string; detail: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { code: "IMAGE_REQUEST_INVALID", detail: "请求体必须是 JSON 对象。" };
  }
  const record = payload as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length > 0) {
    return { code: "IMAGE_REQUEST_INVALID", detail: `请求包含未知字段：${unknown.join(", ")}` };
  }
  if (typeof record.configId !== "string" || record.configId.length === 0) {
    return { code: "IMAGE_REQUEST_INVALID", detail: "configId 必须是非空字符串。" };
  }
  if (record.mode !== "generate" && record.mode !== "edit") {
    return { code: "IMAGE_REQUEST_INVALID", detail: "mode 必须是 generate 或 edit。" };
  }
  const mode: ImageMode = record.mode;
  if (typeof record.prompt !== "string" || record.prompt.trim().length === 0) {
    return { code: "IMAGE_REQUEST_INVALID", detail: "prompt 不能为空。" };
  }
  if (record.prompt.length > IMAGE_LIMITS.maxPromptChars) {
    return { code: "IMAGE_REQUEST_INVALID", detail: `prompt 超过 ${IMAGE_LIMITS.maxPromptChars} 字符。` };
  }
  if (typeof record.size !== "string" || !/^\d{2,5}x\d{2,5}$/.test(record.size)) {
    // 只做形状校验；具体允许值由配置声明。
    return { code: "IMAGE_REQUEST_INVALID", detail: "size 必须是 `宽x高` 形式。" };
  }
  if (record.quality !== "low" && record.quality !== "medium" && record.quality !== "high") {
    return { code: "IMAGE_REQUEST_INVALID", detail: "quality 必须是 low/medium/high。" };
  }
  const quality: ImageQuality = record.quality;
  if (record.outputFormat !== undefined && record.outputFormat !== "png" && record.outputFormat !== "jpeg") {
    return { code: "IMAGE_REQUEST_INVALID", detail: "outputFormat 必须是 png 或 jpeg。" };
  }
  const format = record.outputFormat !== undefined ? { outputFormat: record.outputFormat as ImageOutputFormat } : {};
  const identity = parseIdentity(record.identity);
  if (!identity) {
    return { code: "IMAGE_IDENTITY_INVALID", detail: "缺少有效的图片执行身份信封；本端点不接受匿名执行。" };
  }

  /*
   * 输入图：编辑**恰好一张**（多张修图由调用方逐张发起，不在一次请求里混）；
   * 生成可以 0..N 张——N>1 就是"用这几张图生成一张新图"。超上限直接拒绝，不静默丢图。
   */
  const rawSources = record.sourceImages;
  if (rawSources === undefined) {
    if (mode === "edit")
      return { code: "IMAGE_REQUEST_INVALID", detail: "edit 模式必须携带 sourceImages（恰好一张）。" };
    return { configId: record.configId, mode, prompt: record.prompt, size: record.size, quality, identity, ...format };
  }
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    return { code: "IMAGE_REQUEST_INVALID", detail: "sourceImages 必须是非空数组。" };
  }
  if (mode === "edit" && rawSources.length !== 1) {
    return { code: "IMAGE_REQUEST_INVALID", detail: "edit 模式只能携带一张输入图。" };
  }
  if (rawSources.length > IMAGE_LIMITS.sourceImages) {
    return {
      code: "IMAGE_REQUEST_INVALID",
      detail: `一次最多 ${IMAGE_LIMITS.sourceImages} 张输入图。`
    };
  }
  const sourceImages: { mime: string; base64: string }[] = [];
  // 合计预算：单张都合法但加起来超了也要在**这里**明确拒绝（不是 413）。
  let totalSourceBytes = 0;
  for (const [index, entry] of rawSources.entries()) {
    const where = `sourceImages[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return { code: "IMAGE_REQUEST_INVALID", detail: `${where} 必须是对象。` };
    const source = entry as Record<string, unknown>;
    const sourceUnknown = Object.keys(source).filter((key) => key !== "mime" && key !== "base64");
    if (sourceUnknown.length > 0) {
      return { code: "IMAGE_REQUEST_INVALID", detail: `${where} 包含未知字段：${sourceUnknown.join(", ")}` };
    }
    if (typeof source.mime !== "string" || source.mime.length === 0)
      return { code: "IMAGE_REQUEST_INVALID", detail: `${where}.mime 必须是非空字符串。` };
    if (typeof source.base64 !== "string" || source.base64.length === 0)
      return { code: "IMAGE_REQUEST_INVALID", detail: `${where}.base64 必须是非空字符串。` };
    if (source.base64.length > base64LengthLimit(IMAGE_LIMITS.sourceBytes))
      return { code: "IMAGE_REQUEST_INVALID", detail: `${where} 超过源图字节上限。` };
    // Buffer.from 会忽略内部填充之后的文本；先要求规范 base64，字节预算才与实际解码一致。
    if (!isCanonicalBase64(source.base64))
      return { code: "IMAGE_REQUEST_INVALID", detail: `${where}.base64 格式无效。` };
    const decodedBytes = decodedBase64Bytes(source.base64);
    if (decodedBytes > IMAGE_LIMITS.sourceBytes)
      return { code: "IMAGE_REQUEST_INVALID", detail: `${where} 超过单张 20MiB 原图上限；不会自动缩小。` };
    totalSourceBytes += decodedBytes;
    if (totalSourceBytes > IMAGE_LIMITS.sourceBytesTotal) {
      return { code: "IMAGE_REQUEST_INVALID",
        detail: `本次输入图合计超过 ${Math.round(IMAGE_LIMITS.sourceBytesTotal / 1024 ** 2)} MiB；请减少数量或压缩后再试。` };
    }
    sourceImages.push({ mime: source.mime, base64: source.base64 });
  }
  return {
    configId: record.configId,
    mode,
    prompt: record.prompt,
    ...format,
    size: record.size,
    quality,
    identity,
    sourceImages
  };
}

/** 服务端已保存计划里与本身份对应的执行事实（消息、计划、任务项与已保存的尝试投影）。 */
type VerifiedPlan = {
  attemptNo: number;
};

/**
 * 核对身份确属**已保存**的计划（§4.2.2 + C1.6/C1.7）：
 * 1. 会话/消息/executionId/itemId 存在且对应，attemptId 已以 `prepared` 随计划保存；
 * 2. 配置指纹一致（配置 ID 相同但实际配置变化 → `IMAGE_CONFIG_CHANGED`）；
 * 3. 出站参数与已保存**提示快照逐项一致**：prompt/size/quality/outputFormat 完全相同
 *    （不一致 = 改写了已冻结的出站内容 → `IMAGE_PROMPT_CHANGED`）；
 * 4. 出站来源与快照记录的有序来源摘要逐项一致（数量或顺序不符 → `IMAGE_SOURCES_CHANGED`）。
 * 记录读取失败或历史不完整都不能据此推定未执行——一律拒绝。
 */
function verifyImageIdentity(
  identity: ImageAttemptIdentity,
  configId: string,
  configDigest: string,
  outboundSourceDigests: readonly string[],
  prompt: string,
  size: string,
  quality: string,
  outputFormat?: ImageOutputFormat
): VerifiedPlan | { code: string; detail: string } {
  let session;
  try {
    session = readSession(identity.sessionId);
  } catch (error) {
    if (error instanceof SessionStoreError && error.code === "SESSION_NOT_FOUND") {
      return { code: "IMAGE_IDENTITY_INVALID", detail: "身份指向的会话不存在；未登记任何出站。" };
    }
    return { code: "IMAGE_IDENTITY_UNVERIFIABLE", detail: "身份核对失败（会话存储不可用）；未登记任何出站。" };
  }
  const message = session.payload.messages.find((item) => item.id === identity.messageId);
  if (!message) return { code: "IMAGE_IDENTITY_INVALID", detail: "身份指向的消息不存在。" };
  const plan = message.imagePlan as Record<string, unknown> | undefined;
  if (!plan || plan.executionId !== identity.executionId) {
    return { code: "IMAGE_IDENTITY_INVALID", detail: "身份与该消息已保存的图片计划不符。" };
  }
  const items = Array.isArray(plan.items) ? (plan.items as Record<string, unknown>[]) : [];
  const item = items.find((entry) => entry.itemId === identity.itemId);
  if (!item) return { code: "IMAGE_IDENTITY_INVALID", detail: "身份指向的任务项不在已保存计划里。" };
  const config = plan.config as Record<string, unknown> | undefined;
  if (!config || config.imageConfigId !== configId) {
    return { code: "IMAGE_CONFIG_CHANGED", detail: "已保存计划的制图配置与本次请求不一致；请按原配置重试或新建请求。" };
  }
  if (config.configDigest !== configDigest) {
    return { code: "IMAGE_CONFIG_CHANGED", detail: "制图配置在计划保存后发生了变化；旧任务不能静默换配置重放，请新建请求。" };
  }
  const attempts = Array.isArray(message.imageAttempts) ? (message.imageAttempts as Record<string, unknown>[]) : [];
  const projection = attempts.find((entry) => entry.attemptId === identity.attemptId);
  if (!projection || projection.itemId !== identity.itemId) {
    return { code: "IMAGE_IDENTITY_INVALID", detail: "本次尝试尚未随计划保存；请先保存后再发送。" };
  }
  if (projection.status !== "prepared") {
    return { code: "IMAGE_IDENTITY_INVALID", detail: "该尝试已不处于待发送状态；请先查询原尝试。" };
  }
  // 双向核对：请求与已保存投影对「上一尝试」的认定必须一致（防止旧客户端/旧 ID 误登记）。
  if ((identity.previousAttemptId ?? undefined) !== (projection.previousAttemptId ?? undefined)) {
    return { code: "IMAGE_IDENTITY_INVALID", detail: "上一尝试 ID 与已保存记录不符。" };
  }
  // C1.6：快照在出站前冻结；没有快照（或快照与实际出站不一致）都拒绝，不允许绕过。
  const snapshot = projection.promptSnapshot as Record<string, unknown> | undefined;
  if (!snapshot || typeof snapshot.prompt !== "string" || typeof snapshot.size !== "string" || typeof snapshot.quality !== "string") {
    return { code: "IMAGE_IDENTITY_INVALID", detail: "提示快照未随计划保存；请重新保存后再发送。" };
  }
  if (snapshot.prompt !== prompt || snapshot.size !== size || snapshot.quality !== quality ||
      snapshot.outputFormat !== outputFormat || config.outputFormat !== outputFormat) {
    return { code: "IMAGE_PROMPT_CHANGED", detail: "出站提示与已保存快照不一致；已冻结的出站内容不能改写，请重新发起请求。" };
  }
  const snapshotDigests = Array.isArray(snapshot.sourceDigests) ? (snapshot.sourceDigests as string[]) : [];
  if (
    snapshotDigests.length !== outboundSourceDigests.length ||
    snapshotDigests.some((digest, index) => digest !== outboundSourceDigests[index])
  ) {
    return { code: "IMAGE_SOURCES_CHANGED", detail: "出站来源与已保存快照的有序摘要不一致；请重新发起请求。" };
  }
  return { attemptNo: Number(projection.attemptNo) };
}

/** 供应商失败阶段 → 尝试终态（§4.2：只有可靠终态证据才记确定失败）。 */
function terminalOfFailure(code: string, phase: string): { kind: "failed" | "outcome_unknown"; errorCode: string } {
  if (phase === "prepare" || phase === "upstream" || phase === "response") {
    return { kind: "failed", errorCode: code };
  }
  return { kind: "outcome_unknown", errorCode: code };
}

/** 已登记尝试（非首次 POST）→ 明确的重复请求响应；零新的供应商请求。 */
function responseForExistingRow(row: AttemptRow): Response {
  const attempt = {
    attemptId: row.attemptId,
    status: row.status,
    // 本次 HTTP 请求**没有**调用供应商（重复请求只是回放已登记状态）。
    replayed: true,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.artifactId ? { artifactId: row.artifactId } : {}),
    ...(row.artifactDigest ? { artifactDigest: row.artifactDigest } : {}),
    deadlineAt: row.deadlineAt
  };
  if (row.status === "succeeded") {
    if (row.resultJson) {
      try {
        const stored = JSON.parse(row.resultJson) as { mime?: string; imageBase64?: string; model?: string; configId?: string };
        if (typeof stored.imageBase64 === "string" && typeof stored.mime === "string") {
          return json({
            ok: true, configId: stored.configId ?? "", model: stored.model ?? "", mime: stored.mime,
            bytes: Buffer.byteLength(stored.imageBase64, "base64"), imageBase64: stored.imageBase64,
            reused: true, attempt
          }, 200);
        }
      } catch {
        /* 结果损坏：按已转存处理（产物在会话里，不在本行） */
      }
      return json({ ok: true, transferred: true, attempt }, 200);
    }
    // 已转存进会话：返回引用；客户端应刷新会话而不是再次出站。
    return json({
      ok: true, transferred: true,
      ...(row.artifactMime ? { mime: row.artifactMime } : {}),
      attempt
    }, 200);
  }
  if (row.status === "dispatched" || row.status === "prepared") {
    return fail("IMAGE_ATTEMPT_PENDING", "该尝试已登记且尚未完成；请查询原尝试，零新的供应商请求。", 409, { attempt });
  }
  if (row.status === "outcome_unknown") {
    return fail("IMAGE_ATTEMPT_UNKNOWN", "该尝试结果未知；请先恢复查询，只有显式重新生成才发起新尝试。", 409, { attempt });
  }
  return fail("IMAGE_ATTEMPT_FAILED", row.errorCode ?? "该尝试已确定失败。", 409, { attempt });
}

export async function POST(request: Request): Promise<Response> {
  const gated = requireBetaAccess(request);
  if (gated) return gated;
  // ---- 1. 三道开关判定：全部先于任何配置解析与出站请求 ----
  if (process.env[AI_ENABLED_ENV] !== "1") {
    return fail("AI_DISABLED", "服务端未启用 AI 能力。", 503);
  }
  if (!isAiExecutionEnabled()) {
    return fail(
      "AI_DISABLED",
      "AI 当前不可用，请检查账户的 AI 许可和服务配置；Web 用户可退出后在登录页的隐私协议中更改许可。",
      503
    );
  }
  if (!isImageRouteEnabled()) {
    // 不回显环境变量名：开关名属于部署信息，文案由固定映射给出。
    return fail("IMAGE_DISABLED", safeConfigDetail("IMAGE_DISABLED"), 503);
  }

  // ---- 2. 请求体：流式限额 + JSON 解析 ----
  const raw = await readBodyWithinLimit(request);
  if (raw === null) {
    return fail("IMAGE_REQUEST_TOO_LARGE", "请求体过大。", 413);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail("IMAGE_REQUEST_INVALID", "请求体不是有效 JSON。", 400);
  }

  const parsedBody = parseImageRequest(payload);
  if ("code" in parsedBody) return fail(parsedBody.code, parsedBody.detail, 400);

  // ---- 3. 受控配置解析：未知 ID / 缺密钥 / 非法端点明确失败 ----
  let config;
  try {
    const store = createImageConfigStore(currentScopeEnv() as NodeJS.ProcessEnv);
    if (!store.enabled()) {
      throw new ImageConfigError("IMAGE_DISABLED", "服务端未声明任何图片配置。");
    }
    config = store.resolve(parsedBody.configId);
  } catch (error) {
    if (error instanceof ImageConfigError) {
      /*
       * 只回稳定码 + 固定文案：`error.message` 里带端点与环境变量名，回给浏览器就是
       * 内网拓扑与凭据位置的泄漏；每个码仍保留自己的文案，真实失败不被合并成“未知错误”。
       */
      return fail(error.code, safeConfigDetail(error.code), statusForConfigError(error));
    }
    return fail("IMAGE_INTERNAL_ERROR", "服务端配置读取失败。", 500);
  }
  if (parsedBody.mode === "generate" && !config.capabilities.generate) {
    // 能力未声明与协议不受支持是两回事：错误码必须能区分（便于诊断，也便于前端提示）。
    return fail("IMAGE_CAPABILITY_UNSUPPORTED", "该配置未声明生成能力。", 400);
  }
  const allowedSizes = config.imageSizes && config.imageSizes.length > 0 ? config.imageSizes : IMAGE_SIZES;
  if (parsedBody.outputFormat !== undefined && !imageOutputFormats(config.model).includes(parsedBody.outputFormat)) {
    return fail("IMAGE_REQUEST_INVALID", "该模型不支持所选 output_format。", 400);
  }
  if (!(allowedSizes as readonly string[]).includes(parsedBody.size)) {
    return fail("IMAGE_REQUEST_INVALID", `该配置不支持的 size：${parsedBody.size}（允许：${allowedSizes.join(", ")}）。`, 400);
  }
  if (parsedBody.mode === "edit" && !config.capabilities.edit) {
    return fail("IMAGE_CAPABILITY_UNSUPPORTED", "该配置未声明编辑能力。", 400);
  }
  /*
   * 张数上限按**该配置声明的**能力判：全局上限只挡语法，真正能吃几张由配置说了算
   * （例如千问只声明 1 张，Seedream 10 张）。缺省 1，旧记录也安全。
   */
  const requestedSources = parsedBody.sourceImages?.length ?? 0;
  if (requestedSources > config.maxSourceImages) {
    return fail("IMAGE_REQUEST_INVALID",
      `该配置最多接受 ${config.maxSourceImages} 张输入图（本次 ${requestedSources} 张）；请减少图片或改用支持多图的配置。`, 400);
  }

  // ---- 4. 解码来源并计算有序出站摘要（快照核对与请求摘要都用这一份） ----
  const sources = (parsedBody.sourceImages ?? []).map((source) => ({
    bytes: new Uint8Array(Buffer.from(source.base64, "base64")),
    mime: source.mime
  }));
  const outboundSourceDigests = sources.map((source) => bytesDigest(source.bytes));

  // ---- 5. R1 身份核对：确属已保存计划 + 配置指纹/提示快照/来源摘要逐项一致 ----
  const verified = verifyImageIdentity(
    parsedBody.identity, parsedBody.configId, config.configDigest,
    outboundSourceDigests, parsedBody.prompt, parsedBody.size, parsedBody.quality, parsedBody.outputFormat
  );
  if ("code" in verified) {
    return fail(verified.code, verified.detail,
      verified.code === "IMAGE_IDENTITY_INVALID" || verified.code === "IMAGE_IDENTITY_UNVERIFIABLE" ? 400 : 409);
  }

  // ---- 6. 服务端自行计算请求摘要（不相信客户端自报）并登记出站（事务预留尝试与容量） ----
  const digest = requestDigest({
    mode: parsedBody.mode,
    prompt: parsedBody.prompt,
    size: parsedBody.size,
    quality: parsedBody.quality,
    outputFormat: parsedBody.outputFormat,
    sourceDigests: outboundSourceDigests,
    configDigest: config.configDigest
  });
  const now = () => new Date().toISOString();
  let registered: AttemptRow;
  let alreadyRegistered = false;
  {
    const database = openDatabase();
    try {
      const outcome = registerDispatch(database, {
        attemptId: parsedBody.identity.attemptId,
        sessionId: parsedBody.identity.sessionId,
        messageId: parsedBody.identity.messageId,
        executionId: parsedBody.identity.executionId,
        itemId: parsedBody.identity.itemId,
        attemptNo: verified.attemptNo,
        ...(parsedBody.identity.previousAttemptId ? { previousAttemptId: parsedBody.identity.previousAttemptId } : {}),
        requestDigest: digest,
        configDigest: config.configDigest,
        reservationBytes: IMAGE_LIMITS.responseBodyBytes,
        capacityLimitBytes: SESSION_LIMITS.maxPayloadBytes,
        deadlineAt: new Date(Date.now() + IMAGE_EXECUTION_BUDGET.imageRequestMs + ATTEMPT_DEADLINE_SLACK_MS).toISOString(),
        now: now()
      });
      if (!outcome.ok) {
        if (outcome.code === "ATTEMPT_CONFLICT") {
          return fail("IMAGE_ATTEMPT_CONFLICT", outcome.detail, 409,
            { attempt: { attemptId: parsedBody.identity.attemptId, status: outcome.row?.status } });
        }
        if (outcome.code === "STALE" || outcome.code === "DUPLICATE") {
          return fail("IMAGE_ATTEMPT_CONFLICT", outcome.detail, 409);
        }
        if (outcome.code === "PREVIOUS_SUCCEEDED") {
          // C2：上一尝试已成功——返回其产物引用，客户端走恢复取回，不再出站。
          return fail("IMAGE_ATTEMPT_SUCCEEDED", outcome.detail, 409, {
            attempt: {
              attemptId: outcome.row?.attemptId ?? "",
              status: "succeeded",
              ...(outcome.row?.artifactId ? { artifactId: outcome.row.artifactId } : {}),
              ...(outcome.row?.artifactDigest ? { artifactDigest: outcome.row.artifactDigest } : {})
            }
          });
        }
        return fail("IMAGE_CAPACITY_EXCEEDED", outcome.detail, 400);
      }
      registered = outcome.row;
      alreadyRegistered = outcome.alreadyRegistered === true;
    } catch (error) {
      if (error instanceof ImageExecutionStoreError && error.code === "BUSY") {
        return fail("IMAGE_STORE_BUSY", error.detail, 503);
      }
      return fail("IMAGE_STORE_UNAVAILABLE", "尝试记录不可用；真实付费入口在尝试记录不可用时拒绝执行。", 503);
    } finally {
      database.close();
    }
  }
  /*
   * 重复 POST（相同 attemptId）：登记返回的是既有行——已成功 → 原产物/引用；
   * 在途/未知/失败 → 明确状态。零新的供应商请求。
   */
  if (registered.status !== "dispatched") {
    return responseForExistingRow(registered);
  }
  if (alreadyRegistered) {
    // 相同 attemptId 的重放：已登记且在途——明确状态，零新的供应商请求。
    return fail("IMAGE_ATTEMPT_PENDING", "该尝试已登记且尚未完成；请查询原尝试，零新的供应商请求。", 409,
      { attempt: { attemptId: registered.attemptId, status: registered.status } });
  }

  // ---- 6. 出站：Provider 负责协议、超时与响应校验（dispatched 已持久化） ----
  const result = await createImageProvider(config).run({
    mode: parsedBody.mode,
    prompt: parsedBody.prompt,
    size: parsedBody.size,
    quality: parsedBody.quality,
    outputFormat: parsedBody.outputFormat,
    ...(sources.length > 0 ? { sources } : {}),
    signal: request.signal ?? undefined
  });

  // ---- 7. 终态落库：先持久化产物与状态，再响应客户端 ----
  const attempt = {
    attemptId: registered.attemptId,
    itemId: registered.itemId,
    ...(registered.previousAttemptId ? { previousAttemptId: registered.previousAttemptId } : {})
  };
  if (result.ok) {
    const artifactId = registered.attemptId;
    const artifactDigest = bytesDigest(result.bytes);
    const stored = JSON.stringify({
      artifactId,
      artifactDigest,
      mime: result.mime,
      model: result.model,
      configId: result.configId,
      imageBase64: Buffer.from(result.bytes).toString("base64")
    });
    let persisted = true;
    {
      const database = openDatabase();
      try {
        const outcome = recordTerminal(database, registered.attemptId, {
          kind: "succeeded", artifactId, artifactDigest, artifactMime: result.mime,
          result: JSON.parse(stored) as Record<string, unknown>, resultBytes: Buffer.byteLength(stored, "utf8")
        }, now());
        persisted = outcome.ok;
      } catch {
        persisted = false;
      } finally {
        database.close();
      }
    }
    if (!persisted) {
      // 落库失败不能声称已可靠保存：标记待保存，客户端停止后续项并保留供下载。
      return json({
        ok: true, configId: result.configId, model: result.model, mime: result.mime,
        bytes: result.bytes.byteLength, imageBase64: Buffer.from(result.bytes).toString("base64"),
        pendingSave: true, attempt: { ...attempt, status: "outcome_unknown", errorCode: "IMAGE_RESULT_NOT_PERSISTED" }
      }, 200);
    }
    return json({
      ok: true, configId: result.configId, model: result.model, mime: result.mime,
      bytes: result.bytes.byteLength, imageBase64: Buffer.from(result.bytes).toString("base64"),
      attempt: { ...attempt, status: "succeeded", artifactId, artifactDigest }
    }, 200);
  }
  const terminal = terminalOfFailure(result.code, result.phase);
  {
    const database = openDatabase();
    try {
      recordTerminal(database, registered.attemptId, terminal, now());
    } catch {
      // 终态落库失败：行保持 dispatched，按期限与查询恢复（不冒充任何终态）。
    } finally {
      database.close();
    }
  }
  return fail(result.code, result.detail, result.status, {
    attempt: { ...attempt, status: terminal.kind, errorCode: terminal.errorCode },
    // 账目以实际进入 fetch 阶段为界：prepare 拒绝确定未出站，不得计为供应商调用；
    // 其余阶段（含 network/timeout/cancelled）请求已发出，按已调用标记。
    providerCalled: result.phase !== "prepare"
  });
}
