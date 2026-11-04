"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import { X } from "lucide-react";
import { PhotoViewer } from "@/features/photos/photo-viewer";
import { markdownToBlocks } from "./notebook-markdown";

type PendingPhoto = { id: string; name: string; dataUrl: string };
type ImageCard = { key: string; label: string; src: string; position: number };

/** 笔记编辑与工作台共用的图片叠牌；点击行为由使用方决定。 */
export function StackedImageDeck({
  cards,
  selectedKey,
  selectedKeys,
  onSelect,
  onDoubleSelect,
  onRemove,
  title = "图片",
  action = "跳转到",
  className = "",
  deckRef,
  busy = false
}: {
  cards: ImageCard[];
  selectedKey: string | null;
  selectedKeys?: readonly string[];
  onSelect: (card: ImageCard) => void;
  /** 笔记本的鼠标双击定位；缺省沿用工作台的单击选择。 */
  onDoubleSelect?: (card: ImageCard) => void;
  onRemove?: (card: ImageCard) => void;
  title?: string;
  action?: string;
  className?: string;
  deckRef?: Ref<HTMLElement>;
  busy?: boolean;
}) {
  if (cards.length === 0) return null;
  const quietHeading = !busy && className.split(/\s+/).includes("nb-image-deck--editable");
  return <section ref={deckRef} className={`nb-image-deck ${className}`.trim()} aria-label={`${title}预览`} aria-busy={busy} title={`${title}预览，共 ${cards.length} 张`}>
    <div className={`nb-image-deck-heading${quietHeading ? " ui-secondary-copy" : ""}`}><strong>{title}</strong><span role={busy ? "status" : undefined}>{busy ? "正在准备图片…" : `${cards.length} 张`}</span></div>
    <ol className="nb-image-deck-list">
      {cards.map((card, index) => <li key={card.key} className={selectedKey === card.key || selectedKeys?.includes(card.key) ? "is-active" : ""}
        style={{ "--deck-order": selectedKey === card.key ? cards.length * 2 + 1 : selectedKeys?.includes(card.key) ? cards.length + index + 1 : index + 1,
          "--deck-raised-order": cards.length * 3 + 1, "--deck-depth": Math.min(cards.length - index - 1, 5) } as CSSProperties}>
        <button type="button" className="nb-image-deck-card" disabled={busy || !card.src}
          aria-label={`${action}第 ${index + 1} 张图片：${card.label}`}
          title={`${action}第 ${index + 1} 张图片：${card.label}（共 ${cards.length} 张）`}
          aria-pressed={selectedKey === card.key || !!selectedKeys?.includes(card.key)}
          onClick={(event) => {
            // 键盘与触屏仍可直接定位；鼠标的第一次点击不固定卡牌。
            if (!onDoubleSelect || event.detail === 0 ||
              (event.nativeEvent as PointerEvent).pointerType === "touch" ||
              window.matchMedia("(hover: none)").matches) onSelect(card);
          }}
          onDoubleClick={onDoubleSelect ? () => onDoubleSelect(card) : undefined}>
          {card.src ? <img src={card.src} alt="" loading="lazy" decoding="async" /> : <span className="nb-image-deck-placeholder">图片暂不可用</span>}
          <span className="nb-image-deck-number">{index + 1}</span>
        </button>
        {onRemove ? <button type="button" className="nb-image-deck-remove" disabled={busy}
          aria-label={`删除第 ${index + 1} 张图片：${card.label}`} title="删除图片"
          onClick={() => onRemove(card)}><X size={14} aria-hidden="true" /></button> : null}
      </li>)}
    </ol>
  </section>;
}

function unsupportedSource(markdown: string): string {
  if (markdown.startsWith("![")) return /^!\[[^\]]*\]\(([^)\s]+)\)/.exec(markdown)?.[1] ?? "";
  const match = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(markdown);
  return match?.[1] ?? match?.[2] ?? "";
}

function listImageCards(
  markdown: string,
  mediaUrls: Record<string, string>,
  pendingPhotos: PendingPhoto[]
): ImageCard[] {
  const pending = new Map(pendingPhotos.map((photo) => [photo.id, photo]));
  const seen = new Map<string, number>();
  const cards: ImageCard[] = [];
  for (const block of markdownToBlocks(markdown)) {
    if (block.type === "text") continue;
    const source = block.type === "photo" ? block.mediaId : unsupportedSource(block.markdown);
    const occurrence = seen.get(source) ?? 0;
    seen.set(source, occurrence + 1);
    const label = block.type === "photo" ? block.caption : `图片 ${cards.length + 1}`;
    const src = block.type === "photo"
      ? pending.get(block.mediaId)?.dataUrl ?? mediaUrls[block.mediaId] ?? ""
      : /^(https?:\/\/|\/)/i.test(source) ? source : "";
    cards.push({ key: `${source}#${occurrence}`, label, src, position: cards.length });
  }
  return cards;
}

export function NotebookImageDeck({
  markdown,
  mediaUrls,
  pendingPhotos,
  onRemove
}: {
  markdown: string;
  mediaUrls: Record<string, string>;
  pendingPhotos: PendingPhoto[];
  onRemove: (position: number) => void;
}) {
  const deckRef = useRef<HTMLElement>(null);
  const jumpCleanup = useRef<(() => void) | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ id: string; trigger: HTMLElement }>();
  const cards = useMemo(
    () => listImageCards(markdown, mediaUrls, pendingPhotos),
    [markdown, mediaUrls, pendingPhotos]
  );

  useEffect(() => () => jumpCleanup.current?.(), []);

  useEffect(() => {
    const scroller = deckRef.current?.closest<HTMLElement>(".notebook-edit");
    if (!scroller) return;
    const cardFor = (image: HTMLImageElement) => cards.find(card => card.src === image.src);
    const prepare = () => {
      for (const image of scroller.querySelectorAll<HTMLImageElement>(".journal-markdown-content img")) {
        const card = cardFor(image);
        if (!card) continue;
        image.tabIndex = 0;
        image.setAttribute("role", "button");
        image.setAttribute("aria-label", `查看原图：${card.label || "笔记图片"}`);
      }
    };
    const open = (event: Event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.closest(".journal-markdown-content")) return;
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
      const card = cardFor(image);
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      setViewing({ id: card.key, trigger: image });
    };
    prepare();
    // 编辑器按需挂载、图片异步解析；只观察正文节点增删，不监听样式变化。
    const observer = new MutationObserver(prepare);
    observer.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener("click", open, true);
    scroller.addEventListener("keydown", open, true);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("click", open, true);
      scroller.removeEventListener("keydown", open, true);
    };
  }, [cards]);

  if (cards.length === 0) return null;

  function jumpToImage(card: ImageCard) {
    jumpCleanup.current?.();
    setSelectedKey(card.key);
    const scroller = deckRef.current?.closest<HTMLElement>(".notebook-edit");
    const editor = scroller?.querySelector(
      '.journal-markdown-content[contenteditable="true"]'
    );
    const images = editor?.querySelectorAll<HTMLElement>('[data-editor-block-type="image"]');
    const target = images?.[card.position];
    if (!scroller || !editor || !target) return;
    const align = (behavior: ScrollBehavior) => {
      const top = scroller.scrollTop + target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top - (scroller.clientHeight - target.clientHeight) / 2;
      scroller.scrollTo({ top, behavior });
    };
    align(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

    // 新插入的多张图片可能在点击后才完成排版；短暂监听高度变化，把落点校准到原图。
    let editorHeight = editor.getBoundingClientRect().height;
    let alignTimer = 0;
    let stopTimer = 0;
    const observer = new ResizeObserver(() => {
      const nextHeight = editor.getBoundingClientRect().height;
      if (Math.abs(nextHeight - editorHeight) < 1) return;
      editorHeight = nextHeight;
      window.clearTimeout(alignTimer);
      alignTimer = window.setTimeout(() => align("auto"), 80);
    });
    const cleanup = () => {
      observer.disconnect();
      window.clearTimeout(alignTimer);
      window.clearTimeout(stopTimer);
      scroller.removeEventListener("wheel", cleanup);
      scroller.removeEventListener("touchstart", cleanup);
      if (jumpCleanup.current === cleanup) jumpCleanup.current = null;
    };
    observer.observe(editor);
    scroller.addEventListener("wheel", cleanup, { once: true });
    scroller.addEventListener("touchstart", cleanup, { once: true });
    stopTimer = window.setTimeout(cleanup, 2500);
    jumpCleanup.current = cleanup;
  }

  return <><StackedImageDeck cards={cards} selectedKey={selectedKey} onSelect={jumpToImage}
    onDoubleSelect={jumpToImage} onRemove={(card) => {
      jumpCleanup.current?.();
      setSelectedKey(null);
      onRemove(card.position);
    }} title="笔记图片" className="nb-image-deck--editable" deckRef={deckRef} />
    {viewing && cards.some(card => card.src) ? <PhotoViewer images={cards.filter(card => card.src).map(card => ({ id: card.key, name: card.label || "笔记图片", url: card.src }))}
      initialId={viewing.id} onClose={() => setViewing(undefined)} returnFocus={viewing.trigger} /> : null}
  </>;
}
