/**
 * 移动端内测（T3）：开发地图素材接口在内测部署一律 404（连续实施任务书 §5）。
 * 原实现保留在 git 历史；本文件不读取任何数据、无任何副作用。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function gone(): Response {
  return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
}

export const GET = gone;
export const POST = gone;
export const PUT = gone;
export const DELETE = gone;
export const PATCH = gone;
