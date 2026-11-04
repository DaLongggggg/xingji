import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { isSearchImageUrl, NATIVE_SEARCH_LIMITS, type NativeSearchResult } from "@/features/ai/native-search-contract";
import { readPublicHttpsUrl, type PublicHttpsDeps } from "./public-https";

export const SOURCE_PREVIEW_LIMITS = { sources: 3, pageBytes: 256 * 1024, pageMs: 3000, totalMs: 4000 } as const;

type Element = DefaultTreeAdapterTypes.Element;
const attribute = (node: Element, name: string) => node.attrs.find(attr => attr.name === name)?.value;
const hasClass = (node: DefaultTreeAdapterTypes.ParentNode | null | undefined, name: string): node is Element =>
  !!node && "tagName" in node && (attribute(node, "class") ?? "").split(/\s+/).includes(name);

/** Obvious asset markers only; this does not claim visual or semantic relevance. */
export function isDecorativeSearchImage(url: string): boolean {
  let filename: string;
  try { filename = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? ""); } catch { return true; }
  // A content picture may live under /icons/ or depict a logo. Parent folders and titles are not asset identities.
  return /^(?:favicons?|apple[-_]touch[-_]icon|site[-_]?icon|logo|icon|sprite|avatar)(?:[-_]\d+(?:x\d+)?)?\.[a-z0-9]+$/i.test(filename)
    || /^(?:(?:brand|site|website)[-_]logo|(?:logo|icon)[-_](?:light|dark|white|black))\.[a-z0-9]+$/i.test(filename)
    || /^(?:(?:default|fallback)[-_](?:og|cover|image|share)|(?:og|cover|share|social)[-_](?:default|fallback)|fb[-_]cover)(?:[-_]\d+)?\.[a-z0-9]+$/i.test(filename)
    || /^(?:default|fallback)\.(?:png|jpe?g|webp|gif|svg)$/i.test(filename);
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const values = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];

/** Only verified main containers or structured images explicitly bound to this page are content evidence. */
export function readSourceImage(html: string, pageUrl: URL, source: NativeSearchResult["sources"][number]) {
  const document = parse(html);
  const root = document.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "html");
  const head = root?.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "head");
  if (!head) return undefined;
  const titleNode = head.childNodes.find((node): node is Element => "tagName" in node && node.tagName === "title");
  const pageTitle = titleNode?.childNodes.map(node => "value" in node ? node.value : "").join("") ?? "";
  // Canva may answer 200 with this error page and a generic brand OG image, rather than the requested template.
  if (pageUrl.hostname === "www.canva.cn" && /^\/templates\//.test(pageUrl.pathname)
    && /不支持的客户端|unsupported (?:client|browser)|access denied|just a moment/i.test(pageTitle)) return undefined;
  const absolute = (candidate: string) => {
    try { return new URL(candidate, pageUrl).href; } catch { return undefined; }
  };
  const elements: Element[] = [];
  const nodes: DefaultTreeAdapterTypes.ChildNode[] = [...(root?.childNodes ?? [])].reverse();
  while (nodes.length) {
    const node = nodes.pop()!;
    if (!("tagName" in node)) continue;
    elements.push(node);
    if (node.tagName !== "template") nodes.push(...[...node.childNodes].reverse());
  }
  const excluded = new Set<string>();
  const structured: JsonObject[] = [];
  for (const node of elements) {
    if (node.tagName === "link" && /(?:^|\s)(?:icon|apple-touch-icon|mask-icon)(?:\s|$)/i.test(attribute(node, "rel") ?? "")) {
      const url = absolute(attribute(node, "href") ?? "");
      if (url) excluded.add(url);
    }
    if (node.tagName !== "script" || attribute(node, "type")?.trim().toLowerCase() !== "application/ld+json") continue;
    try {
      const pending: unknown[] = [JSON.parse(node.childNodes.map(child => "value" in child ? child.value : "").join(""))];
      // The page byte cap is primary; also bound traversal of untrusted structured data.
      for (let count = 0; pending.length && count < 500; count++) {
        const value = pending.pop();
        if (Array.isArray(value)) { pending.push(...value); continue; }
        const entry = object(value);
        if (entry) { structured.push(entry); pending.push(...Object.values(entry).filter(item => item !== null && typeof item === "object")); }
      }
    } catch { /* Malformed metadata never licenses a generic OG or body-first fallback. */ }
  }
  const byId = new Map<string, JsonObject>();
  for (const entry of structured) {
    const id = typeof entry["@id"] === "string" ? absolute(entry["@id"]) : undefined;
    if (id && Object.keys(entry).length > 1) byId.set(id, entry);
  }
  const imageUrls = (value: unknown): string[] => values(value).flatMap(item => {
    if (typeof item === "string") {
      const url = absolute(item);
      const linked = url ? byId.get(url) : undefined;
      item = linked ?? item;
      if (typeof item === "string") return url ? [url] : [];
    }
    let image = object(item);
    if (!image) return [];
    const id = typeof image["@id"] === "string" ? absolute(image["@id"]) : undefined;
    if (id) image = byId.get(id) ?? image;
    const candidate = image.contentUrl ?? image.url;
    const url = typeof candidate === "string" ? absolute(candidate) : undefined;
    return url ? [url] : [];
  });
  for (const entry of structured) for (const url of imageUrls(entry.logo)) excluded.add(url);
  const imageFrom = (candidate: string, title: string) => {
    let url: string;
    try { url = new URL(candidate, pageUrl).href; } catch { return undefined; }
    return isSearchImageUrl(url) && !excluded.has(url) && !isDecorativeSearchImage(url)
      ? { url, title: title.slice(0, NATIVE_SEARCH_LIMITS.titleChars), sourceUrl: source.url } : undefined;
  };
  let original: URL;
  try { original = new URL(source.url); } catch { return undefined; }
  const huitu = (url: URL) => url.hostname === "www.huitu.com" && /^\/design\/show\/\d{8}\/\d+\.html$/.test(url.pathname);
  const pic58 = (url: URL) => url.hostname === "y.58pic.com" && /^\/detail\/\d+\/?$/.test(url.pathname);
  const verifiedSite = huitu(original) && huitu(pageUrl) || pic58(original) && pic58(pageUrl);
  if (verifiedSite) for (const node of elements) {
    if (node.tagName === "img") {
      const main = huitu(pageUrl)
        ? hasClass(node, "m-img") && hasClass(node.parentNode, "mimg-wrap") && hasClass(node.parentNode.parentNode, "m-img-wrap")
        : hasClass(node.parentNode, "detail-img-center") && hasClass(node.parentNode.parentNode, "detail-center-img-box");
      const candidate = attribute(node, "src");
      if (main && candidate) {
        const image = imageFrom(candidate, attribute(node, "alt")?.trim() || source.title);
        if (image) return image;
      }
    }
  }
  const pageIdentity = (value: unknown): string | undefined => {
    const candidate = typeof value === "string" ? value : object(value)?.["@id"] ?? object(value)?.url;
    if (typeof candidate !== "string") return undefined;
    try { const url = new URL(candidate, pageUrl); url.hash = ""; return url.href.replace(/\/$/, ""); } catch { return undefined; }
  };
  const pages = new Set([pageIdentity(pageUrl.href), pageIdentity(source.url)]);
  for (const entry of structured) {
    const types = values(entry["@type"]).filter((type): type is string => typeof type === "string")
      .map(type => type.replace(/^https?:\/\/schema\.org\//, ""));
    if (!types.some(type => ["WebPage", "Article", "NewsArticle", "BlogPosting"].includes(type))) continue;
    if (![entry.url, entry["@id"], entry.mainEntityOfPage].some(value => value !== undefined && pages.has(pageIdentity(value)))) continue;
    const title = typeof entry.headline === "string" ? entry.headline : typeof entry.name === "string" ? entry.name : source.title;
    for (const candidate of imageUrls(entry.primaryImageOfPage).concat(imageUrls(entry.image))) {
      const image = imageFrom(candidate, title);
      if (image) return image;
    }
  }
  // OG/Twitter images are share covers, not independent evidence of a page's content image.
  return undefined;
}

function decodePage(bytes: Uint8Array, contentType: string | undefined): string {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 8192));
  const charset = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(contentType ?? "")?.[1]
    ?? /charset\s*=\s*["']?\s*([\w-]+)/i.exec(prefix)?.[1] ?? "utf-8";
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return new TextDecoder().decode(bytes); }
}

/** A small best-effort enhancement; all page reads share the parent search cancellation. */
export async function previewSourceImages(
  sources: NativeSearchResult["sources"], signal: AbortSignal, deps: PublicHttpsDeps = {}
): Promise<NonNullable<NativeSearchResult["images"]>> {
  signal.throwIfAborted();
  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(), SOURCE_PREVIEW_LIMITS.totalMs);
  const overall = AbortSignal.any([signal, total.signal]);
  let results;
  try { results = await Promise.all(sources.slice(0, SOURCE_PREVIEW_LIMITS.sources).map(async source => {
    const pageController = new AbortController();
    const pageTimer = setTimeout(() => pageController.abort(), SOURCE_PREVIEW_LIMITS.pageMs);
    try {
      const url = new URL(source.url);
      url.hash = "";
      const pageSignal = AbortSignal.any([overall, pageController.signal]);
      const page = await readPublicHttpsUrl(url.href, {
        signal: pageSignal, maxBytes: SOURCE_PREVIEW_LIMITS.pageBytes, allowPrefix: true,
        accept: "text/html, application/xhtml+xml;q=0.9"
      }, deps);
      if (page.status !== 200 || pageSignal.aborted) return undefined;
      const mime = page.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      if (mime !== "text/html" && mime !== "application/xhtml+xml") return undefined;
      return readSourceImage(decodePage(page.bytes, page.headers["content-type"]), page.url, source);
    } catch { return undefined; }
    finally { clearTimeout(pageTimer); }
  })); } finally { clearTimeout(totalTimer); }
  signal.throwIfAborted();
  const seen = new Set<string>();
  return results.filter((image): image is NonNullable<typeof image> => {
    if (!image) return false;
    const key = JSON.stringify([image.url, image.sourceUrl]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
