/**
 * 内置模型预设：**只是草稿初值**，不含密钥、不发任何请求。
 *
 * 设计取向（对齐 DSH 的模型配置逻辑）：
 * - 预设描述"这家厂商的默认事实"：地址、协议、结构化输出方式、模型目录、生图路径与尺寸；
 * - 用户选了厂家就**只差一个 API 密钥**；预设填进去的每个字段都仍然可改（展开"自定义设置"），
 *   也可以完全不用预设、手填一条自定义提供方；
 * - 预设**不做能力猜测**：`responseFormat` 等按"该端点确定支持什么"写死，写错会让用户
 *   在第一次真实调用时失败（DeepSeek 只接受 json_object，就是踩过的坑），因此不在这里
 *   做任何自动探测、域名匹配或失败降级；
 * - 服务端不认识预设：落库的仍是具体提供方声明，因此加预设不需要改契约、存储或路由。
 */
import { SEEDREAM_2K_SIZES } from "../creation/creation-image-rules";
import type { ChatApiProtocol } from "./model-settings-contract";

export type PresetModel = { modelId: string; label: string };

/** 对话模型预设。 */
export type ChatPreset = {
  /** 稳定预设 ID：只用于 React key 与测试，不落库、不参与版本。 */
  id: string;
  /** 厂家名称：同时作为提供方名称的初值（用户可改）。 */
  vendor: string;
  baseUrl: string;
  apiProtocol: ChatApiProtocol;
  /**
   * 结构化输出方式。只有该端点确定支持严格 Schema 时才写 `json_schema`；
   * 否则 `json_object`（Schema 由服务端作为指令下发，结果仍过运行时校验）。
   */
  responseFormat: "json_schema" | "json_object";
  models: PresetModel[];
  /** 去哪拿密钥（一句话，不带链接以外的部署信息）。 */
  keyHint: string;
  docsUrl: string;
  /** 这家厂商在本项目里的已知限制，直接显示在卡片上。 */
  note?: string;
};

/** 制图模型预设（OpenAI images 协议及其变体）。 */
export type ImagePreset = {
  id: string;
  vendor: string;
  /** 版本段已包含在 baseUrl 里时，`imagesPath` 只写其后半段。 */
  baseUrl: string;
  imagesPath: string;
  editMode: "edits-multipart" | "generations-image";
  capabilities: { generate: boolean; edit: boolean };
  /** 该端点**实际接受**的尺寸（空数组 = 用项目内置三个）。 */
  imageSizes: string[];
  /**
   * 该端点一次能接受几张**输入图**（参考图/图生图/多图融合共用同一个字段）：
   * 1 = 只接受单张（默认，未声明即 1，绝不猜）；>1 = 支持多图输入生成一张新图。
   */
  maxSourceImages: number;
  watermark?: boolean;
  /** 该端点不接受 `response_format` 时声明（OpenAI gpt-image 系列）。 */
  omitResponseFormat?: boolean;
  imageUrlHosts: string[];
  models: PresetModel[];
  keyHint: string;
  docsUrl: string;
  note?: string;
};

/**
 * 对话模型预设（7 家）。
 * 顺序即界面顺序：先国内直连、后需要自备网络的。
 */
export const CHAT_PRESETS: readonly ChatPreset[] = [
  {
    id: "deepseek",
    vendor: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiProtocol: "openai-completions",
    responseFormat: "json_object",
    // 模型 ID 取自该端点的 `GET /models` 实际返回（不是照抄第三方目录）。
    models: [
      { modelId: "deepseek-flash", label: "DeepSeek Flash（快）" },
      { modelId: "deepseek-v4-pro", label: "DeepSeek V4 Pro（强）" }
    ],
    keyHint: "在 platform.deepseek.com 创建 API Key",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/",
    note: "只支持 json_object；选了 json_schema 会在结构化任务上被上游拒绝。"
  },
  {
    id: "glm",
    vendor: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiProtocol: "openai-completions",
    // 官方文档的结构化输出只有 JSON 模式（response_format: json_object）。
    responseFormat: "json_object",
    models: [
      { modelId: "glm-5.3", label: "GLM-5.3（旗舰）" },
      { modelId: "glm-5.3-flash", label: "GLM-5.3-Flash（快）" },
      { modelId: "glm-5.2", label: "GLM-5.2" },
      { modelId: "glm-4.7", label: "GLM-4.7" }
    ],
    keyHint: "在 bigmodel.cn 个人中心创建 API Key",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
    note: "官方只提供 JSON 模式结构化输出；这里走标准 API 端点（编程套餐是 /api/coding/paas/v4）。"
  },
  {
    id: "openai",
    vendor: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiProtocol: "openai-responses",
    // OpenAI 原生支持严格 Schema，这里用它的 Responses 协议。
    responseFormat: "json_schema",
    models: [
      { modelId: "gpt-5.4", label: "GPT-5.4" },
      { modelId: "gpt-5.4-mini", label: "GPT-5.4 mini" },
      { modelId: "gpt-5.2", label: "GPT-5.2" },
      { modelId: "gpt-4.1", label: "GPT-4.1" }
    ],
    keyHint: "在 platform.openai.com 创建 API Key",
    docsUrl: "https://platform.openai.com/docs/api-reference/responses",
    note: "需要能直连 OpenAI 的网络。"
  },
  {
    id: "claude",
    vendor: "Claude（Anthropic）",
    baseUrl: "https://api.anthropic.com",
    apiProtocol: "anthropic-messages",
    // 不假定 Anthropic 的结构化输出字段：Schema 由服务端作为指令下发，结果仍过本地校验。
    responseFormat: "json_object",
    models: [
      { modelId: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { modelId: "claude-opus-5", label: "Claude Opus 5" },
      { modelId: "claude-haiku-4-5", label: "Claude Haiku 4.5（快）" }
    ],
    keyHint: "在 console.anthropic.com 创建 API Key",
    docsUrl: "https://docs.anthropic.com/zh-CN/docs/intro",
    note: "需要能直连 Anthropic 的网络；结构化输出按 JSON 指令处理。"
  },
  {
    id: "qwen",
    vendor: "通义千问 Qwen",
    baseUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1",
    apiProtocol: "openai-completions",
    // 官方结构化输出文档：JSON Schema 仅 Qwen3.7 / 3.8 系列支持。
    responseFormat: "json_schema",
    models: [
      { modelId: "qwen3.8-max", label: "Qwen3.8-Max（强）" },
      { modelId: "qwen3.7-plus", label: "Qwen3.7-Plus（均衡）" },
      { modelId: "qwen3.8-flash", label: "Qwen3.8-Flash（快）" }
    ],
    keyHint: "在 platform.qianwenai.com 创建 API Key",
    docsUrl: "https://platform.qianwenai.com/docs/developer-guides/getting-started/introduction",
    note: "JSON Schema 只覆盖 Qwen3.7/3.8 系列（换更老的模型要改用 json_object）；密钥要来自千问AI平台，百炼/DashScope 不是同一套端点。"
  },
  {
    id: "kimi",
    vendor: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    apiProtocol: "openai-completions",
    responseFormat: "json_object",
    models: [
      { modelId: "kimi-k3", label: "Kimi K3" },
      { modelId: "kimi-k2.6", label: "Kimi K2.6" },
      { modelId: "kimi-k2-thinking", label: "Kimi K2 Thinking（推理）" }
    ],
    keyHint: "在 platform.moonshot.cn 创建 API Key",
    docsUrl: "https://platform.moonshot.cn/docs/",
    note: "结构化输出用 json_object。"
  },
  {
    id: "gemini",
    vendor: "Gemini（Google）",
    // 本项目只支持三种对话协议（与 DSH 可配置的协议集合一致），Google 原生协议不在其中，
    // 因此走它官方的 OpenAI 兼容端点。
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiProtocol: "openai-completions",
    responseFormat: "json_object",
    models: [
      { modelId: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { modelId: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { modelId: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }
    ],
    keyHint: "在 aistudio.google.com 创建 API Key",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    note: "走 OpenAI 兼容端点；需要能直连 Google 的网络。"
  }
];

/** 制图模型预设。 */
export const IMAGE_PRESETS: readonly ImagePreset[] = [
  {
    id: "seedream",
    vendor: "Seedream（火山方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    imagesPath: "/images/generations",
    // 方舟图片接口在同一路径上用顶层 `image` 字段做图生图/编辑，没有 multipart 的 /images/edits。
    editMode: "generations-image",
    capabilities: { generate: true, edit: true },
    // 方舟 Seedream 4.0-5.0 原生支持单图与多图输入（多图融合）；5.0 Pro 上限 10 张，按最保守的那档声明。
    maxSourceImages: 10,
    // 官方 Pro 的八档 2K；首档是无原图时的默认尺寸，修图按原图比例选档。
    imageSizes: [...SEEDREAM_2K_SIZES],
    // 方舟的 watermark 默认是 true：不显式关掉，出图会带「AI生成」角标。
    watermark: false,
    imageUrlHosts: [],
    models: [
      { modelId: "doubao-seedream-5-0-260128", label: "Seedream 5.0（lite）" },
      { modelId: "doubao-seedream-5-0-pro-260628", label: "Seedream 5.0 Pro" },
      { modelId: "doubao-seedream-5-0-flash-260915", label: "Seedream 5.0 Flash（快）" },
      { modelId: "doubao-seedream-4-5-251128", label: "Seedream 4.5" }
    ],
    keyHint: "在火山方舟控制台创建 API Key",
    docsUrl: "https://ai.volcengine.com/docs/ark-aihub/2647422?lang=zh",
    note: "这是标准按量接口；使用 Agent Plan 请选套餐预设并使用专属密钥。模型 ID 要与你在方舟开通的一致；已关闭默认水印。"
  },
  {
    id: "seedream-agent-plan",
    vendor: "Seedream（方舟 Agent Plan）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    imagesPath: "/images/generations",
    editMode: "generations-image",
    capabilities: { generate: true, edit: true },
    maxSourceImages: 9,
    imageSizes: [...SEEDREAM_2K_SIZES],
    watermark: false,
    imageUrlHosts: [],
    models: [
      { modelId: "doubao-seedream-5-0-pro", label: "Seedream 5.0 Pro" },
      { modelId: "doubao-seedream-5.0-lite", label: "Seedream 5.0 Lite（官方已标记即将下线）" }
    ],
    keyHint: "在火山方舟 Agent Plan 开通管理中获取专属 API Key；不是普通或 Coding Plan Key",
    docsUrl: "https://docs.volcengine.com/docs/ark/agent-plan-personal-visual-models?lang=zh",
    note: "套餐专用地址与模型名称；不自动切换到按量接口。预设使用八档 2K；精准交互编辑请选择 Pro。"
  },
  {
    id: "gpt-image",
    vendor: "GPT Image（OpenAI）",
    baseUrl: "https://api.openai.com/v1",
    imagesPath: "/images/generations",
    editMode: "edits-multipart",
    capabilities: { generate: true, edit: true },
    // OpenAI 的 /images/edits 接受多张输入图（`image[]`）。
    maxSourceImages: 16,
    imageSizes: ["1024x1024", "1536x1024", "1024x1536"],
    // gpt-image 系列不接受 response_format（带了会 400），且本来就返回内联 base64。
    omitResponseFormat: true,
    imageUrlHosts: [],
    models: [
      { modelId: "gpt-image-2", label: "GPT Image 2" },
      { modelId: "gpt-image-1.5", label: "GPT Image 1.5" },
      { modelId: "gpt-image-1", label: "GPT Image 1" },
      { modelId: "gpt-image-1-mini", label: "GPT Image 1 mini（省）" }
    ],
    keyHint: "在 platform.openai.com 创建 API Key",
    docsUrl: "https://platform.openai.com/docs/api-reference/images",
    note: "gpt-image 不接受 response_format（已声明不下发）；需要能直连 OpenAI 的网络。"
  },
  {
    id: "qwen-image",
    vendor: "通义千问图像（千问AI平台）",
    baseUrl: "https://maas.qianwenaiapi.com",
    imagesPath: "/compatible-mode/v1/images/generations",
    // 官方 OpenAI 兼容接口：文生图与图生图共用同一路径，图生图传顶层 `image`。
    editMode: "generations-image",
    capabilities: { generate: true, edit: true },
    // 千问图像的 OpenAI 兼容接口只声明了单图（图生图/编辑）；多图融合未核实，保守按 1 张，避免发出会被拒的数组。
    maxSourceImages: 1,
    imageSizes: ["1024x1024", "1024x1536", "1536x1024"],
    imageUrlHosts: ["*.aliyuncs.com"],
    models: [
      { modelId: "qwen-image-3.0-pro", label: "Qwen-Image 3.0 Pro" },
      { modelId: "qwen-image-3.0", label: "Qwen-Image 3.0" }
    ],
    keyHint: "在 platform.qianwenai.com 创建 API Key",
    docsUrl: "https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image-openai",
    note: "只返回 24 小时有效的图片链接（已声明从 aliyuncs.com 下载）；出站超时已按官方建议设为 600 秒，但工作台单轮墙钟是 60 秒，慢档模型请用创作页直接生成。百炼/DashScope 的图片接口不支持 OpenAI 兼容模式，密钥要来自千问AI平台。"
  }
];

/**
 * 端点上真实的模型 ID → 预设里的可读名称（`doubao-seedream-5-0-260128` → `Seedream 5.0（lite）`）。
 *
 * 配置记录里的名称常常就是模型 ID 本身（按厂家添加时端点的模型串被存成了名称），
 * 界面要显示**名称**时用它换算；认不出就返回 undefined，由调用方回退到配置自己的名称。
 */
export function imagePresetModelLabel(modelId: string): string | undefined {
  for (const preset of IMAGE_PRESETS) {
    const hit = preset.models.find(model => model.modelId === modelId);
    if (hit) return hit.label;
  }
  return undefined;
}
