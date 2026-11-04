import type { NativeSearchMode } from "@/features/ai/native-search-contract";

// Explicit documented aliases/snapshots, not an open-ended model-name prefix match.
// https://developers.openai.com/api/docs/guides/tools-web-search
// https://developers.openai.com/api/docs/models/gpt-5.4
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
const OPENAI_MODELS = new Set([
  "gpt-5", "gpt-5-mini", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro", "gpt-5.5",
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-2025-04-14", "gpt-4.1-mini-2025-04-14",
  "gpt-5.4-2026-03-05", "gpt-5.4-pro-2026-03-05", "gpt-5.4-mini-2026-03-17", "gpt-5.4-nano-2026-03-17"
]);

// Basic web_search_20250305; no dynamic filtering or forced-tool compatibility inferred.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
// https://platform.claude.com/docs/en/models/overview
const ANTHROPIC_MODELS = new Set([
  "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6",
  "claude-haiku-5-5", "claude-haiku-4-5", "claude-haiku-4-5-20251001",
  "claude-fable-5-1", "claude-fable-5"
]);

// MaaS and DashScope are distinct services with independently documented Responses support.
// https://platform.qianwenai.com/docs/developer-guides/tool-calling/web-search
// https://help.aliyun.com/zh/model-studio/web-search
const QWEN_MODELS = new Set([
  "qwen3.8-max", "qwen3.8-max-0902", "qwen3.8-flash", "qwen3.8-2.4t-a95b", "qwen3.8-27b",
  "qwen3.7-max", "qwen3.7-plus", "qwen3.7-flash", "qwen3.7-max-2026-05-20",
  "qwen3.7-plus-2026-05-26", "qwen3.7-flash-2026-07-15",
  "qwen3.6-plus", "qwen3.6-flash", "qwen3.6-35b-a3b",
  "qwen3.6-plus-2026-04-02", "qwen3.6-flash-2026-04-16",
  "qwen3.5-plus", "qwen3.5-flash", "qwen3.5-plus-2026-02-15", "qwen3.5-flash-2026-02-23",
  "qwen3.5-27b", "qwen3.5-35b-a3b", "qwen3.5-122b-a10b", "qwen3.5-397b-a17b",
  "deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731", "glm-5.2", "kimi-k3"
]);
const QWEN_GLOBAL_MODELS = new Set(["qwen3.8-max", "qwen3.8-max-0902", "qwen3.8-flash", "qwen3.8-omni-flash", "deepseek-v4.1-flash-1017"]);

// Only the ordinary Ark API and these documented search examples; opaque ep-* IDs cannot reveal a model.
// https://docs.volcengine.com/docs/ark/web-search?lang=en
const GEMINI_MODELS = new Set(["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);
const DOUBAO_MODELS = new Set(["doubao-seed-2-1-pro-260915", "doubao-seed-2-1-pro-260628"]);

// https://help.aliyun.com/zh/model-studio/regions/
const DASHSCOPE_HOSTS: Record<string, string> = {
  "dashscope.aliyuncs.com": "cn-beijing", "dashscope-intl.aliyuncs.com": "ap-southeast-1",
  "dashscope-us.aliyuncs.com": "us-east-1", "cn-hongkong.dashscope.aliyuncs.com": "cn-hongkong"
};
const QWEN_REGIONS = new Set(["cn-beijing", "ap-southeast-1", "us-east-1", "cn-hongkong", "eu-central-1", "ap-northeast-1"]);

function qwenRegion(host: string): string | undefined {
  if (Object.hasOwn(DASHSCOPE_HOSTS, host)) return DASHSCOPE_HOSTS[host];
  const workspace = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z0-9-]+)\.maas\.aliyuncs\.com$/.exec(host);
  return workspace && workspace[1] !== "trial" && QWEN_REGIONS.has(workspace[2]) ? workspace[2] : undefined;
}

/** Pure capability lookup: no credentials, paid probing, old user-selected mode or chat-protocol dependency. */
export function resolveNativeSearchMode(config: { baseUrl: string; model: string; local?: boolean }): NativeSearchMode {
  if (config.local !== undefined && config.local !== false) return "off";
  // Reject ambiguous URL spellings before URL normalizes backslashes, encoded hosts or dot segments.
  if (typeof config.baseUrl !== "string" || !/^[\x21-\x7e]+$/.test(config.baseUrl) || /[%\\?#]/.test(config.baseUrl)) return "off";
  const raw = /^https:\/\/([^/]+)(\/.*)?$/i.exec(config.baseUrl);
  if (!raw || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw[2] ?? "")) return "off";
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { return "off"; }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || raw[1].toLowerCase().replace(/:443$/, "") !== url.hostname) return "off";
  const path = (raw[2] ?? "").replace(/\/$/, "");
  const common = ["", "/v1", "/v1/responses", "/v1/chat/completions"];
  if (url.hostname === "api.openai.com" && common.includes(path)) return OPENAI_MODELS.has(config.model) ? "openai" : "off";
  if (url.hostname === "api.anthropic.com" && ["", "/v1", "/v1/messages"].includes(path))
    return ANTHROPIC_MODELS.has(config.model) ? "anthropic" : "off";
  // /v1/tools/search takes no model parameter and works independently of the selected chat model.
  // https://api-docs.deepseek.com/api/search/
  if (url.hostname === "api.deepseek.com" && [...common, "/chat/completions", "/responses", "/v1/tools/search"].includes(path)) return "deepseek";
  if (url.hostname === "ark.cn-beijing.volces.com" && ["", "/api/v3", "/api/v3/responses", "/api/v3/chat/completions", "/api/compatible/v1", "/api/compatible/v1/messages"].includes(path))
    return DOUBAO_MODELS.has(config.model) ? "doubao" : "off";

  if (url.hostname === "generativelanguage.googleapis.com" && ["", "/v1beta", "/v1beta/openai", "/v1beta/openai/chat/completions", "/v1beta/interactions"].includes(path))
    return GEMINI_MODELS.has(config.model) ? "gemini" : "off";
  // Independent search APIs do not infer support from a chat model. Coding Plan is deliberately excluded.
  if (url.hostname === "open.bigmodel.cn" && ["", "/api/paas/v4", "/api/paas/v4/chat/completions", "/api/paas/v4/web_search"].includes(path)) return "glm";
  if (url.hostname === "api.moonshot.cn" && [...common, "/v1/tools/search_pro"].includes(path)) return "kimi";
  const qwenPath = ["", "/compatible-mode/v1", "/compatible-mode/v1/responses", "/compatible-mode/v1/chat/completions",
    "/api/v2/apps/protocols/compatible-mode/v1", "/api/v2/apps/protocols/compatible-mode/v1/responses"];
  if (!qwenPath.includes(path)) return "off";
  if (url.hostname === "maas.qianwenaiapi.com") return QWEN_MODELS.has(config.model) || config.model === "deepseek-v4.1-flash" ? "qwen" : "off";
  const region = qwenRegion(url.hostname);
  if (!region) return "off";
  if (region !== "cn-beijing" && region !== "ap-southeast-1") return QWEN_GLOBAL_MODELS.has(config.model) ? "qwen" : "off";
  return QWEN_MODELS.has(config.model) || config.model === "qwen3.8-omni-flash" || config.model === "deepseek-v4.1-flash-1017" ? "qwen" : "off";
}
