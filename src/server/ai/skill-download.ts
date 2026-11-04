/** Public HTTPS acquisition adapter. DNS is checked and pinned; no Git, shell or credentials. */
import { isPublicHttpsAddress, validatePublicHttpsUrl, readPublicHttpsUrl, PublicHttpsError, type PublicHttpsDeps } from "./public-https";
import {
  assertImportPath,
  decodeSkillText,
  isRecord,
  isSkillPackagePath,
  prepareMarkdown,
  prepareSkillFiles,
  SKILL_LIMITS,
  SkillInstallError,
  type SkillImport,
  type SkillTextFile
} from "@/features/skills/skill-package";

export type SkillDownloadDeps = PublicHttpsDeps;
export const isPublicSkillAddress = isPublicHttpsAddress;
export function validateSkillUrl(input: string): URL {
  try { return validatePublicHttpsUrl(input); }
  catch (error) { throw skillError(error); }
}
function skillError(error: unknown): SkillInstallError {
  if (error instanceof SkillInstallError) return error;
  if (error instanceof PublicHttpsError) return new SkillInstallError(error.code === "invalid" ? "SKILL_INVALID" : error.code === "limit" ? "SKILL_LIMIT" : "SKILL_DOWNLOAD", error.message);
  return new SkillInstallError("SKILL_DOWNLOAD", "无法下载内容，请检查链接、网络或来源限制后重试。");
}

function timeoutError(): SkillInstallError {
  return new SkillInstallError("SKILL_DOWNLOAD", "下载超时或已取消，请检查网络后重试。");
}

function connectionError(hostname: string, error: unknown): SkillInstallError {
  if (error instanceof SkillInstallError) return error;
  const code = isRecord(error) ? error.code : undefined;
  const reason = code === "ECONNRESET" ? "连接被重置"
    : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "域名解析失败"
    : code === "ETIMEDOUT" ? "连接超时"
    : code === "ECONNREFUSED" ? "连接被拒绝"
    : code === "ENETUNREACH" || code === "EHOSTUNREACH" ? "网络不可达"
    : typeof code === "string" && /(?:CERT|TLS)/.test(code) ? "安全连接校验失败"
    : "连接失败";
  return new SkillInstallError("SKILL_DOWNLOAD", `无法连接 ${hostname}（${reason}）。请检查运行应用的电脑能否访问该来源，或上传 MD / ZIP 文件。`);
}

export async function downloadSkillUrl(
  input: string,
  deps: SkillDownloadDeps = {},
  callerSignal?: AbortSignal
): Promise<SkillImport> {
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  let requests = 0,
    bytesLeft = 4 * 1024 * 1024;
  async function get(inputUrl: string, maxBytes: number) {
    let result;
    try {
      result = await readPublicHttpsUrl(inputUrl, {
        signal, maxBytes: Math.min(maxBytes, bytesLeft),
        accept: new URL(inputUrl).hostname === "api.github.com" ? "application/vnd.github+json" : "text/markdown, text/plain;q=0.9",
        onRequest: () => {
          if (++requests > 80) throw new SkillInstallError("SKILL_LIMIT", "下载请求过多，请改用具体 Skill 子目录。");
        }
      }, deps);
    } catch (error) {
      if (error instanceof PublicHttpsError) throw skillError(error);
      throw connectionError(new URL(inputUrl).hostname, error);
    }
    bytesLeft -= result.bytes.length;
    if (result.status !== 200) throw new SkillInstallError("SKILL_DOWNLOAD", result.status === 404
      ? "没有找到文件、仓库或分支，请核对链接。" : result.status === 429 || result.status === 403
        ? "来源暂时限制下载，请稍后重试或上传文件。" : `来源下载失败（HTTP ${result.status}）。`);
    return result;
  }
  async function json(endpoint: string): Promise<unknown> {
    const result = await get(`https://api.github.com${endpoint}`, 2 * 1024 * 1024);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes));
    } catch {
      throw new SkillInstallError("SKILL_DOWNLOAD", "GitHub 返回了无效的目录内容。");
    }
  }
  async function markdown(url: string): Promise<string> {
    const result = await get(url, SKILL_LIMITS.textBytes);
    const type = result.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    if (
      type === "text/html" ||
      (!/\.md$/i.test(result.url.pathname) &&
        type !== "text/markdown" &&
        type !== "text/x-markdown")
    )
      throw new SkillInstallError(
        "SKILL_INVALID",
        "链接没有返回 Markdown 文件，请使用 Raw 地址或可直接下载的 .md 链接。"
      );
    return decodeSkillText(result.bytes);
  }
  try {
    const url = validateSkillUrl(input.trim());
    const rawHost = url.hostname === "raw.githubusercontent.com";
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com" && !rawHost)
      return {
        packages: [
          prepareMarkdown(
            await markdown(url.href),
            decodeURIComponent(url.pathname.split("/").at(-1) || "SKILL.md")
          )
        ],
        warnings: []
      };
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .flatMap((part) => decodeURIComponent(part).split("/"));
    const [owner, repository, pageKind, ...pageTail] = parts;
    const kind = rawHost ? "raw" : pageKind;
    const tail = rawHost ? parts.slice(2) : pageTail;
    const repo = repository?.replace(/\.git$/, "");
    if (
      !owner ||
      !repo ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(owner) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(repo) ||
      (kind && !["tree", "blob", "raw"].includes(kind))
    )
      throw new SkillInstallError(
        "SKILL_INVALID",
        "请使用 GitHub 仓库、Skill 子目录或 Markdown 文件地址。"
      );
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    let commit: unknown,
      selectedPath = "";
    if (!kind) {
      const meta = await json(base);
      if (!isRecord(meta) || typeof meta.default_branch !== "string")
        throw new SkillInstallError("SKILL_DOWNLOAD", "无法识别仓库默认分支。");
      const ref = await json(
        `${base}/git/ref/heads/${meta.default_branch.split("/").map(encodeURIComponent).join("/")}`
      );
      commit = isRecord(ref) && isRecord(ref.object) ? ref.object.sha : undefined;
    } else if (/^[0-9a-f]{40}$/i.test(tail[0] ?? "")) {
      commit = tail[0];
      selectedPath = tail.slice(1).join("/");
    } else {
      if (!tail.length)
        throw new SkillInstallError("SKILL_INVALID", "GitHub 链接缺少分支或文件路径。");
      const refs = await json(`${base}/git/matching-refs/heads/${encodeURIComponent(tail[0])}`);
      if (!Array.isArray(refs) || refs.length > 1000)
        throw new SkillInstallError(
          "SKILL_DOWNLOAD",
          "无法识别 GitHub 分支，请使用 Raw Markdown 链接。"
        );
      const matches = refs.filter(
        (ref: unknown) =>
          isRecord(ref) &&
          typeof ref.ref === "string" &&
          ref.ref.startsWith("refs/heads/") &&
          `${tail.join("/")}/`.startsWith(`${ref.ref.slice(11)}/`)
      ) as { ref: string; object?: { sha?: unknown } }[];
      matches.sort((a, b) => b.ref.length - a.ref.length);
      const ref = matches[0];
      if (!ref && rawHost) {
        // Raw links can also use tags; resolve them once to a fixed commit.
        const resolved = await json(`${base}/commits/${encodeURIComponent(tail[0])}`);
        commit = isRecord(resolved) ? resolved.sha : undefined;
        selectedPath = tail.slice(1).join("/");
      } else if (!ref)
        throw new SkillInstallError(
          "SKILL_DOWNLOAD",
          "没有找到链接中的分支，请使用 Raw Markdown 链接。"
        );
      else {
        commit = ref.object?.sha;
        selectedPath = tail.slice(ref.ref.slice(11).split("/").length).join("/");
      }
    }
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/i.test(commit))
      throw new SkillInstallError("SKILL_DOWNLOAD", "无法确定仓库内容版本。");
    if (selectedPath) assertImportPath(selectedPath);
    const singleFile = kind === "blob" || kind === "raw" || /\.md$/i.test(selectedPath);
    if (singleFile && !/\.md$/i.test(selectedPath))
      throw new SkillInstallError("SKILL_INVALID", "请选择 Markdown 文件或 Skill 子目录。");

    async function blob(file: { path: string; sha: string; mode: string; size?: number }): Promise<string> {
      assertImportPath(file.path);
      if (file.mode !== "100644" && file.mode !== "100755")
        throw new SkillInstallError("SKILL_INVALID", "仓库技能包含链接或特殊文件，已拒绝下载。");
      if (typeof file.size === "number" && file.size > SKILL_LIMITS.textBytes)
        throw new SkillInstallError("SKILL_LIMIT", "仓库单个文本超过 256 KiB。");
      if (typeof file.sha !== "string" || !/^[0-9a-f]{40}$/i.test(file.sha))
        throw new SkillInstallError("SKILL_DOWNLOAD", "GitHub 文件版本无效。");
      const data = await json(`${base}/git/blobs/${file.sha}`);
      if (!isRecord(data) || data.sha !== file.sha || data.encoding !== "base64" || typeof data.content !== "string"
        || typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size < 0)
        throw new SkillInstallError("SKILL_DOWNLOAD", "GitHub 返回了无效的文件内容。");
      if (data.size > SKILL_LIMITS.textBytes)
        throw new SkillInstallError("SKILL_LIMIT", "仓库单个文本超过 256 KiB。");
      const encoded = data.content.replace(/[\r\n]/g, "");
      if (encoded.length > Math.ceil(SKILL_LIMITS.textBytes / 3) * 4)
        throw new SkillInstallError("SKILL_LIMIT", "仓库单个文本超过 256 KiB。");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== data.size || bytes.toString("base64") !== encoded)
        throw new SkillInstallError("SKILL_DOWNLOAD", "GitHub 文件编码或大小不完整。");
      return decodeSkillText(bytes);
    }
    // Walk an explicitly selected directory before recursive listing; a small Skill in a
    // large repository should not require downloading the repository's complete tree.
    let treeRef = commit;
    const selectedParts = selectedPath.split("/").filter(Boolean);
    const filename = singleFile ? selectedParts.pop() : undefined;
    if (selectedParts.length > 8)
      throw new SkillInstallError(
        "SKILL_LIMIT",
        "子目录路径过深，请使用 Raw Markdown 或上传 ZIP。"
      );
    for (const part of selectedParts) {
      const children = await json(`${base}/git/trees/${treeRef}`);
      if (!isRecord(children) || children.truncated !== false || !Array.isArray(children.tree))
        throw new SkillInstallError("SKILL_DOWNLOAD", "无法完整读取 Skill 子目录。");
      const child = children.tree.find(
        (entry: unknown) => isRecord(entry) && entry.path === part && entry.type === "tree"
      );
      if (!isRecord(child) || typeof child.sha !== "string" || !/^[0-9a-f]{40}$/i.test(child.sha))
        throw new SkillInstallError("SKILL_DOWNLOAD", "没有找到 Skill 子目录，请核对链接。");
      treeRef = child.sha;
    }
    if (singleFile) {
      const children = await json(`${base}/git/trees/${treeRef}`);
      if (!isRecord(children) || children.truncated !== false || !Array.isArray(children.tree))
        throw new SkillInstallError("SKILL_DOWNLOAD", "无法完整读取文件目录。");
      const file = children.tree.find((entry: unknown) => isRecord(entry) && entry.type === "blob" && entry.path === filename);
      if (!isRecord(file)) throw new SkillInstallError("SKILL_DOWNLOAD", "没有找到 Markdown 文件，请核对链接。");
      return {
        packages: [prepareMarkdown(await blob({ ...file, path: selectedPath } as { path: string; sha: string; mode: string; size?: number }), selectedPath)],
        warnings: []
      };
    }
    const tree = await json(`${base}/git/trees/${treeRef}?recursive=1`);
    if (
      !isRecord(tree) ||
      tree.truncated !== false ||
      !Array.isArray(tree.tree) ||
      tree.tree.length > 10000
    )
      throw new SkillInstallError(
        "SKILL_LIMIT",
        "仓库目录过大或未完整返回，请使用具体 Skill 子目录或上传 ZIP。"
      );
    const blobs = (
      tree.tree.filter(
        (entry: unknown) =>
          isRecord(entry) && entry.type === "blob" && typeof entry.path === "string"
      ) as { path: string; sha: string; mode: string; size?: number }[]
    ).map((entry) => ({
      ...entry,
      path: selectedPath ? `${selectedPath}/${entry.path}` : entry.path
    }));
    const mains = blobs.filter((entry) => /(?:^|\/)skill\.md$/i.test(entry.path));
    if (!mains.length)
      throw new SkillInstallError(
        "SKILL_INVALID",
        "此仓库或子目录中没有 SKILL.md，请提供具体 Markdown 链接。"
      );
    if (mains.length > SKILL_LIMITS.skills)
      throw new SkillInstallError(
        "SKILL_LIMIT",
        "仓库包含超过 20 个技能，请使用具体 Skill 子目录。"
      );
    const needed = blobs.filter((entry) =>
      mains.some((main) => {
        const prefix = main.path.includes("/")
          ? main.path.slice(0, main.path.lastIndexOf("/") + 1)
          : "";
        return (
          entry.path === main.path ||
          (entry.path.startsWith(prefix) && isSkillPackagePath(entry.path.slice(prefix.length)))
        );
      })
    );
    if (needed.length > SKILL_LIMITS.files)
      throw new SkillInstallError("SKILL_LIMIT", "技能附件超过 64 个，请使用更小的子目录。");
    const files: SkillTextFile[] = [];
    for (const file of needed) {
      files.push({
        path: file.path,
        content: await blob(file)
      });
    }
    const result = prepareSkillFiles(files);
    if (blobs.length > needed.length)
      result.warnings.push(
        "只下载技能主文件、可读参考文档与许可证；仓库中的脚本、媒体及其他附件未安装。"
      );
    return result;
  } catch (error) {
    if (error instanceof SkillInstallError) throw error;
    if (signal.aborted) throw timeoutError();
    throw new SkillInstallError(
      "SKILL_DOWNLOAD",
      "无法下载内容，请检查链接、网络或来源限制后重试。"
    );
  }
}
