import { ChevronDown, Search } from "lucide-react";
import { NATIVE_SEARCH_ARGS, NATIVE_SEARCH_RESULT } from "@/features/ai/native-search-contract";
import type { WorkbenchToolBlock } from "./workbench-types";
import { WorkbenchSearchImages, type PreviewSearchImage } from "./workbench-search-images";
import { uniqueSearchImages } from "./workbench-media-projection";

function queryFromArgs(argsDigest: string): string | undefined {
  try {
    const parsed = NATIVE_SEARCH_ARGS.safeParse(JSON.parse(argsDigest));
    return parsed.success ? parsed.data.query.trim() : undefined;
  } catch { return undefined; }
}

/** 来源只来自成功工具的完整结果；旧记录继续显示它原有的摘要。 */
export function WorkbenchSearchBlock({ tool, pending, duration, onPreviewImage, workPreview }: {
  tool: WorkbenchToolBlock;
  pending: boolean;
  duration?: string;
  onPreviewImage?: PreviewSearchImage;
  /** Work may preview results immediately; final delivery owns images outside the audit details. */
  workPreview?: boolean;
}) {
  const cancelled = tool.cancelled || tool.summary === "已取消";
  const searching = !cancelled && tool.ok === undefined && pending;
  const state = cancelled ? "已取消" : tool.ok === true ? "已完成"
    : searching ? "搜索中" : tool.ok === undefined || tool.summary === "已中断" ? "已中断" : "失败";
  const parsed = tool.ok === true && !cancelled ? NATIVE_SEARCH_RESULT.safeParse(tool.search) : undefined;
  const search = parsed?.success && parsed.data.sources.length ? parsed.data : undefined;
  const query = search?.query.trim() || (tool.ok !== true || cancelled ? queryFromArgs(tool.argsDigest) : undefined);
  const summary = search?.summary || tool.summary;
  const images = uniqueSearchImages(search?.images ?? []);
  const previewing = workPreview ?? pending;
  const gallery = images.length && onPreviewImage ? <WorkbenchSearchImages images={images} onPreview={onPreviewImage} /> : null;

  const grounding = search?.grounding;
  // Opaque origin + no scripts/forms/top navigation. Provider HTML never enters the application DOM.
  const widget = grounding ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'"><base target="_blank">${grounding.html}` : undefined;
  return <><details className="wb-block wb-block-thinking wb-block-search" data-streaming={searching} data-search-state={state}>
    <summary>
      <span className="wb-search-heading"><Search size={14} aria-hidden />联网搜索</span>
      <span className="wb-block-meta" role="status" aria-atomic="true">{state}{images.length ? ` · 找到 ${images.length} 张图片` : ""}{duration ? ` · ${duration}` : ""}</span>
      <ChevronDown className="wb-search-chevron" size={14} aria-hidden />
    </summary>
    <div className="wb-block-body" aria-label="联网搜索详情">
      {query ? <p className="wb-search-query"><span>搜索词</span>{query}</p> : null}
      {search?.sources.length ? <ul className="wb-search-sources" aria-label="搜索来源">
        {search.sources.map((source, index) => {
          const domain = new URL(source.url).host.replace(/^www\./, "");
          return <li key={`${source.url}-${index}`}>
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              <span>{source.title.trim() || domain}</span>{" "}<small>{domain}</small>
            </a>
          </li>;
        })}
      </ul> : null}
      {summary && !grounding ? <p className="wb-search-summary">{summary}</p> : null}
      {search?.truncated || tool.truncated ? <p className="wb-search-limit">搜索结果已按长度限制保留。</p> : null}
      {!previewing ? gallery : null}
    </div>
  </details>
    {grounding ? <div className="wb-search-grounding" aria-label="Google 搜索依据">
      <p style={{ whiteSpace: "pre-wrap" }}>{grounding.text}</p>
      <iframe title="Google 搜索建议" srcDoc={widget} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
        style={{ width: "100%", minHeight: 140, border: 0, background: "white" }} />
    </div> : null}
    {previewing ? gallery : null}
    {search && !search.images?.length ? <p className="wb-search-no-image" role="note">本次未取得可预览图片，可打开网页来源查看。</p> : null}
  </>;
}
