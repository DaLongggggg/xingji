import { NextResponse } from "next/server";
import {
  AtlasResourceError,
  isSafePackageId,
  readAtlasManifest,
  readAtlasResource,
  resolveAtlasPackageDirectory
} from "@/features/atlas/server/atlas-resource";
import { ATLAS_MANIFEST_ID } from "@/features/atlas/atlas-package-manifest";

/** 同源地图数据包。生产只读取显式配置的目录，不自动分发开发素材。 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ resource: string }> }) {
  const directory = resolveAtlasPackageDirectory();
  if (!directory) return new NextResponse("Not Found", { status: 404 });
  const { resource } = await context.params;
  if (!isSafePackageId(resource)) return new NextResponse("Not Found", { status: 404 });

  try {
    const manifest = readAtlasManifest(undefined, { directory });
    if (resource === ATLAS_MANIFEST_ID) {
      return NextResponse.json(manifest, { headers: { "cache-control": "no-store" } });
    }
    const result = readAtlasResource(resource, { directory, manifest });
    return new NextResponse(result.text, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": String(result.bytes)
      }
    });
  } catch (error) {
    if (error instanceof AtlasResourceError) return new NextResponse(error.message, { status: error.status });
    return new NextResponse("地图数据包读取失败。", { status: 500 });
  }
}
