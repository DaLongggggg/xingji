"use client";
import { useRef } from "react";
import { imagePoint, type ImageBounds } from "./workbench-image-edit-contract";
/** Selection is measured on the actual zoomed image plane, never on its contain padding or viewport. */
export function WorkbenchImageSelection({ width, height, bounds, onChange }: { width: number; height: number; bounds?: ImageBounds; onChange: (bounds: ImageBounds) => void }) {
  const start = useRef<{ x: number; y: number; pointerId: number } | undefined>(undefined);
  const point = (event: React.PointerEvent<HTMLDivElement>) => imagePoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), width, height);
  return <div className="wb-viewer-selection" aria-label="拖动框选图片区域" role="group"
    onClick={event => event.stopPropagation()}
    onPointerDown={event => { event.preventDefault(); event.stopPropagation(); if (!event.isPrimary || event.button !== 0) return;
      const p = point(event); start.current = { ...p, pointerId: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { event.preventDefault(); event.stopPropagation(); const first = start.current; if (!first || first.pointerId !== event.pointerId) return;
      const p = point(event), next = { left: Math.min(first.x, p.x), top: Math.min(first.y, p.y), right: Math.max(first.x, p.x), bottom: Math.max(first.y, p.y) };
      if (next.right > next.left && next.bottom > next.top) onChange(next); }}
    onPointerUp={event => { event.preventDefault(); event.stopPropagation(); start.current = undefined; }}
    onPointerCancel={event => { event.stopPropagation(); start.current = undefined; }}>
    {bounds ? <div className="wb-viewer-selection-box" style={{ left: `${bounds.left / width * 100}%`, top: `${bounds.top / height * 100}%`, width: `${(bounds.right - bounds.left) / width * 100}%`, height: `${(bounds.bottom - bounds.top) / height * 100}%` }} /> : null}
  </div>;
}
