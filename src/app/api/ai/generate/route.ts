import { readCustomInstructions } from "@/server/ai/model-settings-store";
import { withCustomInstructions } from "@/features/ai/custom-instructions";
import {
  buildWorkbenchMessages,
  buildWorkbenchPlanMessages,
  buildWorkbenchStreamMessages,
  WORKBENCH_PLAN_SCHEMA,
  WORKBENCH_SCHEMA
} from "@/features/ai/prompts/workbench";
import { isSemanticSearchEnabled } from "@/features/ai/search-chunks";
import { isImageRouteEnabled } from "@/server/ai/image-config";
import { RAG_RESULT_SCHEMA, buildRagMessages } from "@/features/ai/rag-answer";
/**
 * P1-04：受控 AI Gateway 路由（Next.js App Router）。
 *
 * 与 LEGACY `/api/v1/ai/**` 无关：这里是新的 Gateway，**默认关闭**，
 * 只接受受控配置 ID 与已声明的任务类型，不提供任意代理。
 *
 * 启用条件（全部满足才可用）：
 * 1. `XINGJI_AI_ENABLED=1`；
 * 2. `XINGJI_AI_CONFIGS` 指向至少一条受控配置且凭据可用；
 * 3. **非生产环境**：本项目没有认证系统，因此无认证的生产环境**一律关闭**，
 *    没有任何环境变量可以开放它（原 `XINGJI_AI_ALLOW_UNAUTHENTICATED` 绕过已删除）。
 */
import { ORGANIZE_PAGE_RESULT_SCHEMA } from "@/features/ai/ai-result-schema";
import { requireBetaAccess } from "@/server/ai/session-http";
import { currentScopeEnv } from "@/server/ai/user-scope";
import { CAPTURE_ORGANIZE_RESULT_SCHEMA } from "@/features/ai/ai-capture-result-schema";
import { NOTEBOOK_ANALYSIS_RESULT_SCHEMA } from "@/features/ai/ai-notebook-result-schema";
import { PAGE_METADATA_RESULT_SCHEMA } from "@/features/ai/ai-metadata-result-schema";
import {
  LIGHT_AGENT_GROUPING_RESULT_SCHEMA,
  LIGHT_AGENT_PLAN_RESULT_SCHEMA
} from "@/features/ai/ai-light-agent-schema";
import { DESIGN_IMAGE_RESULT_SCHEMA, designImageResultSchema } from "@/features/creation/creation-image-rules";
import { IMAGE_SIZES } from "@/features/creation/creation-image-limits";
import { buildDesignImageMessages } from "@/server/ai/creation-image-prompt";
import { resolveDesignSkillContents, type DesignSkillContent } from "@/server/ai/skill-catalog";
import {
  buildLightAgentPlanMessages,
  buildLightAgentSynthesisMessages
} from "@/features/ai/prompts/light-agent";
import { buildCaptureOrganizeMessages } from "@/features/ai/prompts/capture-organize";
import { buildNotebookAnalysisMessages } from "@/features/ai/prompts/notebook-analysis";
import { buildPageMetadataMessages } from "@/features/ai/prompts/page-metadata";
import { buildPageOrganizeMessages } from "@/features/ai/prompts/page-organize";
import {
  GATEWAY_LIMITS,
  parseGatewayRequest,
  runGateway,
  runGatewayStream,
  type GatewayFailure,
  type GatewayImageInput,
  type GatewayTaskType
} from "@/server/ai/ai-gateway";
import type { AiMessage } from "@/server/ai/openai-compatible-provider";
import {
  AI_ENABLED_ENV,
  createModelConfigStore,
  isAiExecutionEnabled,
  isLightAgentEnabled,
  ModelConfigError,
  safeConfigDetail
} from "@/server/ai/model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 系统提示与结果 Schema 由服务端按**已声明任务类型**固定分发，客户端无法覆盖。
 * 用 Record 而不是嵌套三元：新增任务时漏配会在这里编译失败，而不是静默走错分支。
 */
/*
 * 消息构造器：**视觉任务由这里接收 images 并放进多模态消息**。
 * 曾经这里写成 `(input) => MESSAGE_BUILDERS[task](input)`，把网关校验过的 images 丢掉，
 * 结果产品链路里模型根本看不到图（只有直接调用供应商的探针能看到）——
 * 这也是"选图理由顺着文案编"的真正原因（Astra R4）。
 */
const MESSAGE_BUILDERS: Record<
  GatewayTaskType,
  (input: string, images?: readonly GatewayImageInput[]) => AiMessage[]
> = {
  workbench_chat: buildWorkbenchMessages,
  workbench_chat_stream: buildWorkbenchStreamMessages,
  // 计划轮同时接收工具清单与本轮附图；丢掉 images 会让模型只能根据文件名猜。
  workbench_plan: buildWorkbenchPlanMessages,
  // 搜索由网关分支直接执行，供应商只接收校验后的公开搜索词。
  workbench_web_search: () => [],
  organize_page: buildPageOrganizeMessages,
  organize_captures: buildCaptureOrganizeMessages,
  analyze_notebook: buildNotebookAnalysisMessages,
  generate_page_metadata: buildPageMetadataMessages,
  answer_search: buildRagMessages,
  plan_collection: buildLightAgentPlanMessages,
  synthesize_collection: buildLightAgentSynthesisMessages,
  design_image_prompt: (input: string) => buildDesignImageMessages(input)
};

/** 流式任务不要求 JSON 结果，因此这里是部分映射：缺失即“不做结构校验”。 */
const RESULT_SCHEMAS: Partial<Record<GatewayTaskType, { name: string; schema: unknown }>> = {
  workbench_chat: WORKBENCH_SCHEMA,
  workbench_plan: WORKBENCH_PLAN_SCHEMA,
  organize_page: ORGANIZE_PAGE_RESULT_SCHEMA,
  organize_captures: CAPTURE_ORGANIZE_RESULT_SCHEMA,
  analyze_notebook: NOTEBOOK_ANALYSIS_RESULT_SCHEMA,
  generate_page_metadata: PAGE_METADATA_RESULT_SCHEMA,
  answer_search: RAG_RESULT_SCHEMA,
  plan_collection: LIGHT_AGENT_PLAN_RESULT_SCHEMA,
  synthesize_collection: LIGHT_AGENT_GROUPING_RESULT_SCHEMA,
  design_image_prompt: DESIGN_IMAGE_RESULT_SCHEMA
};

/** 纯文本请求体上限（字节）。 */
const MAX_BODY_BYTES = 96 * 1024;
/**
 * 视觉请求体上限（字节）：9 张 ≤512KiB 的图 → base64 ≈ 4/3，再留余量。
 * 只有声明支持视觉的**任务+配置**才会用到这个更大的上限。
 */
const MAX_VISION_BODY_BYTES = 8 * 1024 * 1024;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function fail(error: GatewayFailure): Response {
  return json({ ok: false, code: error.code, detail: error.detail }, error.status);
}

/** 流式读取请求体，超过字节上限立即停止，避免全量读入后才判断。 */
async function readBodyWithinLimit(request: Request, limit = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;

  const body = request.body;
  if (!body) {
    const text = await request.text();
    return byteLength(text) > limit ? null : text;
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
      if (bytes > limit) {
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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export async function POST(request: Request): Promise<Response> {
  const gated = requireBetaAccess(request);
  if (gated) return gated;
  if (process.env[AI_ENABLED_ENV] !== "1") {
    return fail({ ok: false, code: "AI_DISABLED", detail: "服务端未启用 AI 能力。", status: 503 });
  }
  if (!isAiExecutionEnabled()) {
    return fail({
      ok: false,
      code: "AI_DISABLED",
      detail: "AI 当前不可用，请检查账户的 AI 许可和服务配置；Web 用户可退出后在登录页的隐私协议中更改许可。",
      status: 503
    });
  }

  let store;
  try {
    store = createModelConfigStore(currentScopeEnv() as NodeJS.ProcessEnv);
  } catch (error) {
    if (error instanceof ModelConfigError) {
      // 稳定码 + 固定安全文案：`error.message` 含端点与环境变量名，只用于服务端诊断。
      return fail({ ok: false, code: error.code, detail: safeConfigDetail(error.code), status: 503 });
    }
    return fail({
      ok: false,
      code: "AI_INTERNAL_ERROR",
      detail: "服务端配置读取失败。",
      status: 500
    });
  }

  /*
   * P9-04：请求体一次读完，上限取「图片」上限；**纯文本请求仍按原来的较小上限判定**，
   * 因此文本路径的字节边界与之前完全一致，只有带图片的请求才可能用到更大体量。
   * 是否真的接受图片由 parseGatewayRequest（任务白名单 + 逐图字节/类型/张数）与配置的
   * vision 声明共同决定（fail-closed）。
   */
  const raw = await readBodyWithinLimit(request, MAX_VISION_BODY_BYTES);
  if (raw === null) {
    return fail({ ok: false, code: "AI_INPUT_TOO_LARGE", detail: "请求体过大。", status: 413 });
  }
  if (byteLength(raw) > MAX_BODY_BYTES && !raw.includes('"images"')) {
    return fail({ ok: false, code: "AI_INPUT_TOO_LARGE", detail: "请求体过大。", status: 413 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail({
      ok: false,
      code: "AI_REQUEST_INVALID",
      detail: "请求体不是有效 JSON。",
      status: 400
    });
  }

  const parsed = parseGatewayRequest(payload);
  if ("ok" in parsed) return fail(parsed);
  if (parsed.task === "answer_search" && !isSemanticSearchEnabled()) {
    return fail({ ok: false, code: "AI_DISABLED", detail: "引用回答暂未启用。", status: 503 });
  }
  /*
   * P8：需总 AI 许可，部署显式设为 0 时另行禁用；
   * 关闭时在这里明确拒绝，未创建 Provider、未发出任何上游请求。
   */
  if (
    (parsed.task === "plan_collection" || parsed.task === "synthesize_collection") &&
    !isLightAgentEnabled()
  ) {
    return fail({
      ok: false,
      code: "AI_DISABLED",
      // 不回显开关名（部署信息）：只说清“哪个功能没开、下一步看哪里”。
      detail: "整理检索结果功能当前未启用，需由部署方在服务端开启。",
      status: 503
    });
  }
  /*
   * `design_image_prompt` 是**图片链路**的一步（生图/修图前由文本模型写图像提示），
   * 图片提示设计跟图片能力开关走；图片没开时同样零请求拒绝。
   */
  if (parsed.task === "design_image_prompt" && !isImageRouteEnabled()) {
    return fail({
      ok: false,
      code: "AI_DISABLED",
      detail: "生图与修图当前未启用，需由部署方在服务端开启图片能力。",
      status: 503
    });
  }

  /*
   * 阶段B：设计轮声明「读过什么」（id + 摘要 + 窗口），正文由服务端按同一窗口
   * **重新读取并核对摘要**——请求方不能自带正文或名字，资源已变化明确失败。
   * 未携带即基础方法。输出契约定死为四字段 Schema，不随资源变化。
   */
  let responseSchemaOverride: { name: string; schema: unknown } | undefined;
  let designSkillContents: DesignSkillContent[] = [];
  let designResources: { id: string; digest?: string }[] | undefined;
  if (parsed.task === "design_image_prompt") {
    const resolved = await resolveDesignSkillContents(parsed.input ?? "{}");
    if (!resolved.ok) {
      const status = resolved.code === "AI_SKILL_RESOURCE_CHANGED" ? 409
        : resolved.code === "AI_SKILL_RESOURCE_UNAVAILABLE" ? 403
        : resolved.code === "AI_SKILL_STATE_UNREADABLE" ? 503
        : 400;
      return fail({ ok: false, code: resolved.code, detail: resolved.detail, status });
    }
    designSkillContents = resolved.contents;
    designResources = resolved.resources;
    const designInput = JSON.parse(parsed.input) as { allowedSizes?: unknown; promptOptions?: { size?: unknown } };
    if (!designInput || typeof designInput !== "object" || Array.isArray(designInput))
      return fail({ ok: false, code: "AI_INPUT_INVALID", detail: "提示设计输入必须是对象。", status: 400 });
    const sizes = designInput.allowedSizes ?? IMAGE_SIZES;
    if (!Array.isArray(sizes) || !sizes.length || sizes.length > 64
      || !sizes.every(size => typeof size === "string" && /^\d{1,5}x\d{1,5}$/.test(size)))
      return fail({ ok: false, code: "AI_INPUT_INVALID", detail: "提示设计需要合法的尺寸列表。", status: 400 });
    const selectedSize = designInput.promptOptions?.size;
    if (selectedSize !== undefined && !sizes.includes(selectedSize))
      return fail({ ok: false, code: "AI_INPUT_INVALID", detail: "所选尺寸不在本次可用列表中。", status: 400 });
    responseSchemaOverride = designImageResultSchema(selectedSize ? [selectedSize as string] : sizes);
  }
  const responseSchema = responseSchemaOverride ?? RESULT_SCHEMAS[parsed.task];
  // 设计轮的已读资源是**请求局部**的：组装器经这里闭包注入（不进模块级状态）。
  let customInstructions = "";
  try {
    if (["workbench_plan", "workbench_chat", "workbench_chat_stream"].includes(parsed.task)) customInstructions = readCustomInstructions(currentScopeEnv());
  } catch {
    return fail({ ok: false, code: "AI_SETTINGS_DOC_UNREADABLE", detail: "自定义指令暂时无法读取，本次未发送。", status: 503 });
  }
  const buildMessagesOf = (task: GatewayTaskType) =>
    task === "design_image_prompt"
      ? (input: string) => buildDesignImageMessages(input, designSkillContents)
      : MESSAGE_BUILDERS[task];
  // R4（§7.1）：服务端组装消息的可统计文本字符（system + 资源正文 + 用户输入）。
  // 组装失败时保持未知（缺省），不得伪造 0。
  const serverEstimateChars: number | undefined = (() => {
    try {
      const messages = withCustomInstructions(parsed.task, buildMessagesOf(parsed.task)(parsed.input, parsed.images), customInstructions);
      return messages.reduce((sum, message) => {
        if (typeof message.content === "string") return sum + message.content.length;
        return sum + (message.content as { text?: string }[]).reduce(
          (inner: number, part) => inner + (typeof part.text === "string" ? part.text.length : 0), 0);
      }, 0);
    } catch {
      return undefined;
    }
  })();

  const deps = {
    configs: store,
    customInstructions,
    buildMessages: (task: GatewayTaskType, input: string, images?: readonly GatewayImageInput[]) =>
      buildMessagesOf(task)(input, images),
    responseSchema,
    timeoutMs: GATEWAY_LIMITS.timeoutMs
  };

  /*
   * 流式分支：`stream: true` 时按 NDJSON 逐行推送事件（一行一事件，客户端增量解析）。
   * 事件协议见 server/ai/stream-protocols：恰好一个终止事件，失败也以 error + done 收束。
   */
  const wantsStream = typeof payload === "object" && payload !== null && (payload as { stream?: unknown }).stream === true;
  if (wantsStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // R4（§7.1）：先下发服务端组装文本的字符估算（system + 资源正文 + 用户输入）；未知则不发，客户端保持未知。
          if (typeof serverEstimateChars === "number") {
            controller.enqueue(encoder.encode(
              `${JSON.stringify({ type: "server_estimate", textChars: serverEstimateChars })}\n`
            ));
          }
          // R4：design 任务再下发模式与资源版本（客户端记入调用账目）；体量只走 server_estimate。
          if (parsed.task === "design_image_prompt") {
            const designMode = designSkillContents.length > 0 ? "skill" : "base";
            controller.enqueue(encoder.encode(
              `${JSON.stringify({ type: "design_meta", designMode, resources: designResources ?? [] })}\n`
            ));
          }
          for await (const event of runGatewayStream(deps, { ...parsed, signal: request.signal ?? undefined })) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
        } catch {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: "error", code: "AI_INTERNAL_ERROR", message: "流式转发失败。", retryable: true })}\n`
            )
          );
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done", reason: "error" })}\n`));
        } finally {
          controller.close();
        }
      }
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no"
      }
    });
  }

  const result = await runGateway(
    deps,
    { ...parsed, signal: request.signal ?? undefined }
  );
  if (!result.ok) return fail(result);

  return json(
    {
      ok: true,
      configId: result.configId,
      model: result.model,
      content: result.content,
      usage: result.usage ?? null,
      // R4（§7.1）：服务端组装消息的可统计文本字符；组装失败时缺省（保持未知，不伪造 0）。
      ...(typeof serverEstimateChars === "number" ? { estimate: { textChars: serverEstimateChars } } : {}),
      // design_image_prompt 回显实际采用的模式与所用资源版本（基础方法为空数组）。
      ...(parsed.task === "design_image_prompt"
        ? { designMode: designSkillContents.length > 0 ? "skill" as const : "base" as const, resources: designResources ?? [] }
        : {})
    },
    200
  );
}
