import { scoreQuickNotes } from "./workbench-search";
export { scoreQuickNotes } from "./workbench-search";
/**
 * 工作台演示适配层：**唯一**的模拟入口。
 *
 * 约束（本轮任务书）：
 * - 不发任何网络请求、不调用真实模型、不写真实笔记本；
 * - 输出一律带 `demo: true`，界面据此显示「演示」标记；
 * - 延迟与失败可注入，方便做出生成中/失败状态与测试；
 * - 组件不允许自己造假数据，全部经这里。
 *
 * 生产入口使用真实工作台适配层；本文件只供隔离演示。
 */
import { createCaptureId } from "@/features/capture/capture-model";
import type {
  MaterialReference,
  WorkbenchAdapter,
  WorkbenchIntent,
  WorkbenchResult,
  WorkbenchScope
} from "./workbench-types";
import { buildWritePreview, describeScope } from "./workbench-types";

export type DemoAdapterOptions = {
  /** 每次生成的模拟耗时；测试传 0。 */
  delayMs?: number;
  /** 强制失败，用于验证失败态；默认只对「修图但没有图片」这类真实语义错误失败。 */
  failWith?: string;
};

function scopeLabel(scope: WorkbenchScope): string {
  return scope.kind === "free" ? "自由对话" : `《${describeScope(scope)}》`;
}

function materialBlock(references: MaterialReference[], text: string): string {
  const body = references.map((item) => `- ${item.text.replace(/\s+/g, " ").trim()}`).join("\n");
  if (body && text) return `${body}\n${text}`;
  return body || text;
}

function demoResult(intent: WorkbenchIntent, prompt: string, hasImage: boolean): WorkbenchResult {
  const id = createCaptureId("demo");
  const subject = prompt.trim() || "这次旅行";
  switch (intent) {
    case "image-generate":
      return {
        id,
        kind: "image",
        title: "配图方案",
        caption: subject.slice(0, 60),
        from: "#8fc3e8",
        to: "#17689b",
        demo: true
      };
    case "image-edit":
      return {
        id,
        kind: "image",
        title: "修图预览",
        caption: hasImage ? subject.slice(0, 60) : "缺少原图",
        from: "#cbd9e6",
        to: "#3f6b8c",
        demo: true
      };
    case "handbook-page":
      return {
        id,
        kind: "handbook-page",
        title: subject.slice(0, 24) || "旅行手帐页",
        subtitle: "一页排版 · 演示作品",
        blocks: [
          { heading: "开场", body: prompt.trim() || "这一页从路上的一段话说起。" },
          { heading: "照片", body: "预留两张竖图与一段说明文字。" },
          { heading: "小结", body: "把当天最想留下的三件事排成要点。" }
        ],
        demo: true
      };
    case "copywriting":
      return {
        id,
        kind: "text",
        title: "文案草稿",
        body: `【演示文案】\n${subject}\n\n写法：先写场景，再写感受，最后给一句可以带走的句子。`,
        demo: true
      };
    case "summarize":
      return {
        id,
        kind: "text",
        title: "要点整理",
        body: `【演示整理】\n· 主题：${subject}\n· 线索一：行程与停留时间\n· 线索二：印象最深的地点\n· 线索三：可继续展开的细节`,
        demo: true
      };
    default:
      return {
        id,
        kind: "text",
        title: "对话回复",
        body: `【演示回复】我在${scopeLabel({ kind: "free" } as WorkbenchScope)}里看到你的问题：“${subject}”。\n本轮是界面原型，回复内容由演示适配层生成，未调用真实模型。`,
        demo: true
      };
  }
}

export function createDemoWorkbenchAdapter(options: DemoAdapterOptions = {}): WorkbenchAdapter {
  const delayMs = options.delayMs ?? 900;

  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("已取消", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new DOMException("已取消", "AbortError"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });

  return {
    async send({ scope, text, intent, references, attachments, signal }) {
      await wait(delayMs, signal);
      if (options.failWith) throw new Error(options.failWith);
      // 真实的语义错误：修图没有原图，不该假装成功。
      if (intent === "image-edit" && attachments.length === 0) {
        throw new Error("修图需要先附加一张图片。");
      }
      const prompt = materialBlock(references, text);
      if (!prompt.trim()) throw new Error("请先写点内容，或引用随记素材。");
      void scope;
      return demoResult(intent, prompt, attachments.length > 0);
    },

    async searchQuickNotes({ query, notes }) {
      await wait(Math.min(delayMs, 400), new AbortController().signal);
      return scoreQuickNotes(query, notes);
    },

    async writeResult({ result, target, noteBody }) {
      await wait(Math.min(delayMs, 400), new AbortController().signal);
      const preview = buildWritePreview(result, target.kind === "insert-into-note" ? noteBody : undefined);
      return {
        target,
        preview,
        demo: true,
        message:
          target.kind === "insert-into-note"
            ? `演示：内容已生成并预览，未写入《${target.noteTitle}》。`
            : `演示：已生成《${target.title}》的草稿，未写入《${target.notebookTitle}》。`
      };
    }
  };
}
