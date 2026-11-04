"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download, Info, Minus, Plus, Share2, X } from "lucide-react";
import { readPhotoInfo, type PhotoInfo } from "./photo-info";
import { PhotoInfoPanel } from "./photo-info-panel";

/** url 必须指向保存的完整版本；组件不缩图、不写入或删除媒体。 */
export type PhotoViewImage = {
  id: string; name: string; url: string; blob?: Blob;
  sourceUrl?: string; sourceLabel?: string; versionLabel?: string;
};

function readableSourceUrl(value?: string) {
  try { return value && ["http:", "https:"].includes(new URL(value).protocol) ? value : undefined; }
  catch { return undefined; }
}

/** 沿用既有缩放和模态机制。调用方仅在可读来源列表非空时挂载；关闭即卸载。 */
export function PhotoViewer({ images, initialId, onClose, returnFocus, external = false, variant = "default", renderFooter, renderOverlay, onDownload, onShare }: {
  images: PhotoViewImage[]; initialId: string; onClose: () => void; returnFocus?: HTMLElement | null;
  /** 外部搜索图仅预览，不读取本地照片信息或向图站发送来源页面。 */
  external?: boolean;
  variant?: "default" | "workbench";
  renderFooter?: (image: PhotoViewImage) => ReactNode;
  renderOverlay?: (image: PhotoViewImage, size: { width: number; height: number }) => ReactNode;
  onDownload?: (image: PhotoViewImage) => void | Promise<void>;
  /** T8：原生分享（文件字节经受控 file URI；返回即认为已交系统分享面板）。 */
  onShare?: (image: PhotoViewImage) => void | Promise<void>;
}) {
  const workbench = variant === "workbench";
  const [imageId, setImageId] = useState(initialId);
  const zoomedImage = images.find(image => image.id === imageId) ?? images[0];
  const zoomList = images;
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomBaseSize, setZoomBaseSize] = useState<{ width: number; height: number }>();
  const zoomDialogRef = useRef<HTMLDialogElement>(null);
  useDismissableLayer(zoomDialogRef, true, onClose);
  const zoomImageRef = useRef<HTMLImageElement>(null);
  const zoomViewportRef = useRef<HTMLDivElement>(null);
  const zoomPercentRef = useRef(100);
  const zoomRawRef = useRef(100);
  const zoomFitRef = useRef(100);
  const zoomAnchorRef = useRef<{ x: number; y: number; previous: number } | undefined>(undefined);
  const zoomPointersRef = useRef(new Map<number, { x: number; y: number; startX: number; startY: number }>());
  const zoomPinchRef = useRef<{ distance: number; percent: number } | undefined>(undefined);
  const zoomPointerMovedRef = useRef(false);
  const zoomSuppressClickUntilRef = useRef(0);
  const [infoOpen, setInfoOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [infoState, setInfoState] = useState<{ id: string; info: PhotoInfo }>();
  const [downloadState, setDownloadState] = useState<{ id: string; busy: boolean; notice: string }>();
  const downloadTicket = useRef(0);
  const backgroundScroll = useRef<{ element: HTMLElement; top: number; left: number }[]>([]);
  const restoreBackgroundScroll = useCallback(() => {
    for (const { element, top, left } of backgroundScroll.current) {
      if (!element.isConnected) continue;
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  }, []);
  useLayoutEffect(() => {
    if (!workbench || !returnFocus) return;
    const positions = [];
    for (let element = returnFocus.parentElement; element; element = element.parentElement)
      positions.push({ element, top: element.scrollTop, left: element.scrollLeft });
    backgroundScroll.current = positions;
  }, [workbench, returnFocus]);
  useEffect(() => () => {
    if (!returnFocus?.isConnected) return;
    returnFocus.focus({ preventScroll: true });
    if (workbench) restoreBackgroundScroll();
  }, [returnFocus, workbench, restoreBackgroundScroll]);
  const changePreviewZoom = useCallback((value: number, clientX?: number, clientY?: number) => {
    const nextRaw = Math.max(0.01, Math.min(400, value));
    const next = Math.round(nextRaw * 100) / 100;
    zoomRawRef.current = nextRaw;
    if (next === zoomPercentRef.current) return;
    const viewport = zoomViewportRef.current;
    const previous = zoomPercentRef.current;
    zoomAnchorRef.current = viewport && clientX !== undefined && clientY !== undefined
      ? { x: clientX - viewport.getBoundingClientRect().left,
          y: clientY - viewport.getBoundingClientRect().top, previous }
      : undefined;
    zoomPercentRef.current = next;
    setZoomPercent(next);
  }, []);
  const fitZoomImage = useCallback((preserveManual = false) => {
    const image = zoomImageRef.current;
    const viewport = zoomViewportRef.current;
    if (!image?.naturalWidth || !image.naturalHeight || !viewport) return;
    const fit = Math.min(1,
      Math.max(1, workbench ? viewport.clientWidth - 32 : Math.min(720, viewport.clientWidth - 32)) / image.naturalWidth,
      Math.max(1, workbench ? viewport.clientHeight - 32 : Math.min(560, viewport.clientHeight - 32)) / image.naturalHeight);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const wasFit = Math.abs(zoomPercentRef.current - zoomFitRef.current) <= 0.1;
    zoomFitRef.current = fit * 100;
    if (!preserveManual || wasFit) changePreviewZoom(fit * 100);
    setZoomBaseSize(current => current?.width === width && current.height === height ? current : { width, height });
  }, [changePreviewZoom, workbench]);
  useEffect(() => {
    const dialog = zoomDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      downloadTicket.current += 1;
      if (dialog?.open) dialog.close();
    };
  }, []);
  useEffect(() => {
    fitZoomImage();
    const viewport = zoomViewportRef.current;
    const pointers = zoomPointersRef.current;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1);
      changePreviewZoom(zoomRawRef.current * Math.exp(-delta * 0.002), event.clientX, event.clientY);
    };
    const onResize = () => fitZoomImage(workbench);
    const observer = workbench && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => fitZoomImage(true)) : undefined;
    if (viewport) observer?.observe(viewport);
    viewport?.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);
    return () => {
      viewport?.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      pointers.clear();
      zoomPinchRef.current = undefined;
    };
  }, [fitZoomImage, changePreviewZoom, workbench]);
  // 同一 URL 也可对应不同来源身份；无需等待浏览器再次触发 load。
  // F1 崩溃点：deps 在渲染期求值，空列表时 zoomedImage 为 undefined——先安全求值。
  useLayoutEffect(() => {
    if (zoomedImage) fitZoomImage();
  }, [zoomedImage?.id, zoomedImage?.url, fitZoomImage]);
  useLayoutEffect(() => {
    const viewport = zoomViewportRef.current;
    if (!viewport) return;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = undefined;
    if (anchor) {
      const ratio = zoomPercent / anchor.previous;
      viewport.scrollLeft = (viewport.scrollLeft + anchor.x) * ratio - anchor.x;
      viewport.scrollTop = (viewport.scrollTop + anchor.y) * ratio - anchor.y;
    } else {
      viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
    }
  }, [zoomedImage?.id, zoomPercent, zoomBaseSize]);
  const onPreviewPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    zoomPointersRef.current.set(event.pointerId,
      { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
    if (zoomPointersRef.current.size === 2) {
      const [first, second] = [...zoomPointersRef.current.values()];
      zoomPinchRef.current = { distance: Math.hypot(first.x - second.x, first.y - second.y), percent: zoomRawRef.current };
    }
  };
  const onPreviewPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = zoomPointersRef.current.get(event.pointerId);
    if (!previous) return;
    zoomPointersRef.current.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY });
    if (zoomPointersRef.current.size >= 2 && zoomPinchRef.current?.distance) {
      const [first, second] = [...zoomPointersRef.current.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (Math.abs(distance - zoomPinchRef.current.distance) > 3) zoomPointerMovedRef.current = true;
      changePreviewZoom(zoomPinchRef.current.percent * distance / zoomPinchRef.current.distance,
        (first.x + second.x) / 2, (first.y + second.y) / 2);
      return;
    }
    if (Math.abs(event.clientX - previous.startX) + Math.abs(event.clientY - previous.startY) > 4) zoomPointerMovedRef.current = true;
    const viewport = zoomViewportRef.current;
    if (viewport) {
      viewport.scrollLeft -= event.clientX - previous.x;
      viewport.scrollTop -= event.clientY - previous.y;
    }
  };
  const onPreviewPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    zoomPointersRef.current.delete(event.pointerId);
    if (zoomPointersRef.current.size < 2) zoomPinchRef.current = undefined;
    if (zoomPointerMovedRef.current) zoomSuppressClickUntilRef.current = Date.now() + 450;
    if (zoomPointersRef.current.size === 0) zoomPointerMovedRef.current = false;
  };
  const closePreviewOnBlank = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (Date.now() < zoomSuppressClickUntilRef.current) {
      zoomSuppressClickUntilRef.current = 0;
      return;
    }
    if (event.target === event.currentTarget) onClose();
  };
  const canReadInfo = workbench
    ? !!zoomedImage.blob || !external && /^(blob:|data:image\/)/.test(zoomedImage.url)
    : !external;
  useEffect(() => {
    if (!canReadInfo || !infoOpen) return;
    let active = true;
    const controller = new AbortController();
    // 只回读由本应用持有的本地来源，不为外链抓取图片或绕过其权限。
    const read = async () => {
      const blob = zoomedImage.blob ?? (/^(blob:|data:image\/)/.test(zoomedImage.url)
        ? await fetch(zoomedImage.url, { signal: controller.signal }).then(response => {
          if (!response.ok) throw new Error("原件暂不可读");
          return response.blob();
        }) : undefined);
      const info = await readPhotoInfo(blob ?? new Uint8Array());
      if (active) setInfoState({ id: zoomedImage.id, info });
    };
    void read().catch(() => { if (active) void readPhotoInfo(new Uint8Array()).then(info => {
      if (active) setInfoState({ id: zoomedImage.id, info: { ...info, status: "unreadable" } });
    }); });
    return () => { active = false; controller.abort(); };
  }, [canReadInfo, infoOpen, zoomedImage?.id, zoomedImage?.url, zoomedImage?.blob]);
  const stepImagePreview = (delta: number) => {
    const index = images.findIndex(image => image.id === zoomedImage.id);
    setImageId(images[(index + delta + images.length) % images.length].id);
    setZoomBaseSize(undefined);
    setImageFailed(false);
    zoomPointersRef.current.clear();
    zoomPinchRef.current = undefined;
  };
  const download = async () => {
    if (!onDownload) return;
    const ticket = ++downloadTicket.current;
    const image = zoomedImage;
    setDownloadState({ id: image.id, busy: true, notice: "正在准备下载…" });
    try {
      await onDownload(image);
      if (ticket === downloadTicket.current) setDownloadState({ id: image.id, busy: false, notice: "已发起下载。" });
    } catch (error) {
      if (ticket === downloadTicket.current) setDownloadState({ id: image.id, busy: false,
        notice: error instanceof Error && error.message ? `下载失败：${error.message}` : "下载失败，请重试。" });
    }
  };
  // F1 防御：调用方统一出口保证非空；此处对空列表保持无崩溃（不渲染模态）。
  if (!zoomedImage) return null;
  const previewPosition = images.findIndex(image => image.id === zoomedImage.id) + 1;
  const sourceUrl = readableSourceUrl(zoomedImage.sourceUrl);
      return <dialog ref={zoomDialogRef} className="wb-image-preview-dialog" data-variant={variant}
        aria-label={`图片预览：${zoomedImage.name}`}
        onCancel={event => { event.preventDefault(); onClose(); }}
        onKeyDown={event => {
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          const target = event.target;
          if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable], [role='textbox']"))) return;
          if (zoomList.length < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          // 适应大小时方向键翻图；放大后方向键留给滚动查看细节。
          if (zoomPercent > zoomFitRef.current + 0.1) return;
          event.preventDefault();
          stepImagePreview(event.key === "ArrowLeft" ? -1 : 1);
        }}>
        <div className="wb-image-preview-toolbar">
          {!workbench ? <span className="wb-image-preview-name" title={zoomedImage.name}>{zoomedImage.name}</span> : null}
          {workbench || zoomList.length > 1 ? (
            <span className="wb-image-preview-nav">
              {zoomList.length > 1 ? <button type="button" aria-label="上一张图片" onClick={() => stepImagePreview(-1)}>
                <ChevronLeft size={18} aria-hidden />
              </button> : null}
              <span className="wb-image-preview-position" role="status">{previewPosition}/{zoomList.length}</span>
              {zoomList.length > 1 ? <button type="button" aria-label="下一张图片" onClick={() => stepImagePreview(1)}>
                <ChevronRight size={18} aria-hidden />
              </button> : null}
            </span>
          ) : null}
          <button type="button" aria-label="缩小图片" disabled={zoomPercent <= 0.01}
            onClick={() => changePreviewZoom(zoomPercentRef.current - 25)}><Minus size={18} aria-hidden /></button>
          <button type="button" className="wb-image-preview-scale" aria-label="恢复图片初始大小"
            onClick={() => changePreviewZoom(zoomFitRef.current)}>适应{workbench ? ` ${Math.round(zoomPercent)}%` : ""}</button>
          <button type="button" aria-label="放大图片" disabled={zoomPercent >= 400}
            onClick={() => changePreviewZoom(zoomPercentRef.current + 25)}><Plus size={18} aria-hidden /></button>
          {!workbench ? <>
            <button type="button" className="photo-viewer-text-button" aria-label="按原始像素查看图片" onClick={() => changePreviewZoom(100)}>1:1</button>
            <span className="photo-viewer-percent" aria-live="polite">{Math.round(zoomPercent)}%</span>
          </> : null}
          {workbench && onShare ? <button type="button" aria-label="分享图片" onClick={() => void onShare(zoomedImage)}><Share2 size={17} aria-hidden /><span className="sr-only">分享</span></button> : null}
          {workbench && onDownload ? <button type="button" aria-label="下载图片" disabled={downloadState?.id === zoomedImage.id && downloadState.busy}
            onClick={() => void download()}><Download size={18} aria-hidden /></button> : null}
          {workbench || !external ? <button type="button" className="photo-viewer-text-button" aria-label={workbench ? "图片信息" : "照片信息"} aria-pressed={infoOpen} onClick={() => setInfoOpen(value => !value)}>
            {workbench ? <Info size={18} aria-hidden /> : "信息"}
          </button> : null}
          <button type="button" className="wb-image-preview-close" aria-label="关闭图片预览"
            onClick={() => onClose()}><X size={22} aria-hidden /></button>
        </div>
        {infoOpen && workbench ? <div className="photo-viewer-workbench-info" aria-label="图片信息内容">
          <dl>
            <div><dt>名称</dt><dd>{zoomedImage.name}</dd></div>
            <div><dt>像素尺寸</dt><dd>{zoomBaseSize ? `${zoomBaseSize.width} × ${zoomBaseSize.height}` : imageFailed ? "未解码" : "正在读取…"}</dd></div>
            {sourceUrl || zoomedImage.sourceLabel ? <div><dt>来源</dt><dd>{sourceUrl
              ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{zoomedImage.sourceLabel || new URL(sourceUrl).host}</a>
              : zoomedImage.sourceLabel}</dd></div> : null}
            {zoomedImage.versionLabel ? <div><dt>版本</dt><dd>{zoomedImage.versionLabel}</dd></div> : null}
          </dl>
          <button type="button" className="photo-viewer-original" aria-label="按原始像素查看图片" onClick={() => changePreviewZoom(100)}>按原始像素查看 · 1:1</button>
          {canReadInfo ? <PhotoInfoPanel info={infoState?.id === zoomedImage.id ? infoState.info : undefined} /> : null}
        </div> : infoOpen && !external ? <PhotoInfoPanel info={infoState?.id === zoomedImage.id ? infoState.info : undefined} /> : null}
        {workbench && downloadState?.id === zoomedImage.id ? <p className="photo-viewer-notice" role="status">{downloadState.notice}</p> : null}
        {imageFailed ? <p role="status" className="photo-info-panel">{external
          ? "图片暂时无法显示，请返回消息打开来源页面查看。"
          : "当前浏览器不能显示这张原图；照片信息读取与原件保存不受影响。"}</p> : null}
        <div ref={zoomViewportRef} className="wb-image-preview-content" role="region"
          aria-label="图片查看区域：滚轮或双指缩放，拖动查看" tabIndex={0}
          onPointerDown={onPreviewPointerDown} onPointerMove={onPreviewPointerMove}
          onPointerUp={onPreviewPointerEnd} onPointerCancel={onPreviewPointerEnd}
          onClick={closePreviewOnBlank}>
          <div className="wb-image-preview-stage" onClick={closePreviewOnBlank}>
            {/* 保持完整本地来源，next/image 的派生请求不适用于原图查看。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img ref={zoomImageRef} src={zoomedImage.url} alt={zoomedImage.name} draggable={false} referrerPolicy={external ? "no-referrer" : undefined} onLoad={() => { setImageFailed(false); fitZoomImage(); if (workbench) restoreBackgroundScroll(); }} onError={() => setImageFailed(true)}
              style={zoomBaseSize ? {
                width: `${Math.round(zoomBaseSize.width * zoomPercent / 100)}px`,
                height: `${Math.round(zoomBaseSize.height * zoomPercent / 100)}px`,
                maxWidth: "none",
                maxHeight: "none"
              } : undefined} />
            {workbench && renderOverlay && zoomBaseSize && !imageFailed ? <div className="wb-viewer-overlay-plane" style={{
              width: Math.round(zoomBaseSize.width * zoomPercent / 100), height: Math.round(zoomBaseSize.height * zoomPercent / 100)
            }}>{renderOverlay(zoomedImage, zoomBaseSize)}</div> : null}
          </div>
        </div>
        {workbench && renderFooter ? <div className="photo-viewer-workbench-footer">{renderFooter(zoomedImage)}</div> : null}
      </dialog>;

}
