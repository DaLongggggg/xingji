/**
 * 仅用于**受控浏览器验收**的隔离夹具：把运行时配置覆盖文件重置为一条种子配置。
 *
 * 为什么需要它：`e2e/settings-config.spec.ts` 跑的是**真实写接口**，如果沿用上一次运行留下的
 * 配置文件，用例之间会互相污染（表现是“配置越来越多”、删除示例已不存在）。
 * 每次运行前显式重置，才能让断言只反映本次操作。
 *
 * 边界（本路由不是产品能力）：
 * - 只在**非生产**环境、且显式声明了 `XINGJI_AI_CONFIGURE_RESET=1` 时可用，否则一律 404；
 * - 只接受 POST，只写 `XINGJI_AI_CONFIG_FILE` 指向的那一个文件，写入固定种子内容；
 * - 不读密钥、不回显配置内容；未声明覆盖文件时 404。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE_ENV } from "@/server/ai/model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const E2E_RESET_ENV = "XINGJI_AI_CONFIGURE_RESET";

const SEED = {
  revision: 1,
  configs: [
    {
      id: "seeded",
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "seeded-model",
      apiKeyEnv: "E2E_MOCK_KEY",
      local: true,
      capabilities: { structuredOutput: true, stream: false, vision: false, tools: false }
    }
  ]
};

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
}

export async function POST(): Promise<Response> {
  // T2a：beta 部署一律 404——这是桌面 E2E 专用夹具，不属于内测产品面。
  if (process.env.XINGJI_BETA_ROOT) return notFound();
  const file = process.env[CONFIG_FILE_ENV];
  if (
    process.env.NODE_ENV === "production" ||
    process.env[E2E_RESET_ENV] !== "1" ||
    !file
  ) {
    return notFound();
  }
  const temp = `${file}.${process.pid}.reset.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(SEED, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
  } catch {
    rmSync(temp, { force: true });
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
