"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

type DismissReason = "outside" | "escape" | "back";
type Layer = { element: HTMLElement; order: number; dismiss?: (reason: DismissReason) => void; consumeOutside?: boolean };
type RegisteredLayer = { ref: RefObject<HTMLElement | null>; order: number; dismiss: Layer["dismiss"]; consumeOutside: boolean };
const layers = new Set<RegisteredLayer>();
const openedAt = new WeakMap<HTMLElement, number>();
const automaticTitles = new WeakMap<HTMLElement, string>();
let sequence = 0;
let listeners = 0;
let swallowClick = false;

function visible(element: HTMLElement) {
  if (!element.isConnected || element.closest("[hidden], [inert], dialog:not([open])")) return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open) return false;
  }
  return true;
}

function orderOf(element: HTMLElement) {
  if (!openedAt.has(element)) openedAt.set(element, ++sequence);
  return openedAt.get(element)!;
}

function topLayer(): Layer | undefined {
  const candidates: Layer[] = [...layers].flatMap(layer => {
    const element = layer.ref.current;
    return element && visible(element) ? [{ element, order: layer.order, dismiss: layer.dismiss, consumeOutside: layer.consumeOutside }] : [];
  });
  for (const element of document.querySelectorAll<HTMLDetailsElement>("details[data-dismiss-layer][open]")) {
    if (!visible(element)) continue;
    candidates.push({ element, order: orderOf(element), dismiss: () => {
      const restoreFocus = element.contains(document.activeElement);
      element.open = false;
      openedAt.delete(element);
      if (restoreFocus) element.querySelector("summary")?.focus();
    } });
  }
  // 编辑器的 Radix 浮层沿用其自带的关闭行为；外层不得抢先收起。
  for (const element of document.querySelectorAll<HTMLElement>("[data-radix-popper-content-wrapper]")) {
    if (element.firstElementChild?.matches('[role="tooltip"], [data-state="closed"]')) continue;
    if (visible(element) && getComputedStyle(element).display !== "none") {
      candidates.push({ element, order: orderOf(element) });
    }
  }
  return candidates.filter(candidate => !candidates.some(other =>
    other.element !== candidate.element && candidate.element.contains(other.element)
  )).sort((a, b) => b.order - a.order)[0];
}

function isInside(layer: Layer, event: MouseEvent) {
  if (!event.composedPath().includes(layer.element)) return false;
  // 原生 dialog 的 backdrop 事件以 dialog 本身为 target。
  if (event.target === layer.element && layer.element instanceof HTMLDialogElement) {
    const bounds = layer.element.getBoundingClientRect();
    return event.clientX > bounds.left && event.clientX < bounds.right &&
      event.clientY > bounds.top && event.clientY < bounds.bottom;
  }
  return true;
}

function consume(event: Event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function outside(event: MouseEvent) {
  const layer = topLayer();
  if (!layer || isInside(layer, event)) return false;
  if (layer.dismiss) {
    if (layer.consumeOutside !== false) consume(event);
    layer.dismiss("outside");
  }
  return layer.consumeOutside !== false;
}

function pointerDown(event: PointerEvent) {
  swallowClick = false;
  if (event.button === 0) swallowClick = outside(event);
}

function click(event: MouseEvent) {
  if (swallowClick) {
    swallowClick = false;
    consume(event);
    return;
  }
  if (event.button === 0) outside(event);
}

function keyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const layer = topLayer();
  if (!layer?.dismiss) return;
  consume(event);
  layer.dismiss("escape");
}

/** Android Back closes one existing top layer before page navigation or native fallback. */
function nativeBack(event: Event) {
  const layer = topLayer();
  if (!layer?.dismiss) return;
  consume(event);
  layer.dismiss("back");
}

function toggle(event: Event) {
  const element = event.target;
  if (!(element instanceof HTMLDetailsElement) || !element.hasAttribute("data-dismiss-layer")) return;
  if (element.open) openedAt.set(element, ++sequence);
  else openedAt.delete(element);
}

function hint(event: Event) {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>("button, summary, [role='button']");
  if (!button) return;
  const previous = automaticTitles.get(button);
  if (button.title.trim() && button.title !== previous) return;
  const labelledBy = button.getAttribute("aria-labelledby")?.split(/\s+/)
    .map(id => document.getElementById(id)?.textContent ?? "").join(" ");
  const label = (button.getAttribute("aria-label") || labelledBy || button.textContent || "").replace(/\s+/g, " ").trim();
  if (!label) return;
  button.title = label;
  automaticTitles.set(button, label);
}

function retainInteractions() {
  if (listeners++ === 0) {
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("xingji:native-back", nativeBack, true);
    document.addEventListener("toggle", toggle, true);
    document.addEventListener("pointerover", hint, true);
    document.addEventListener("focusin", hint, true);
  }
  return () => {
    if (--listeners !== 0) return;
    document.removeEventListener("pointerdown", pointerDown, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", keyDown, true);
    document.removeEventListener("xingji:native-back", nativeBack, true);
    document.removeEventListener("toggle", toggle, true);
    document.removeEventListener("pointerover", hint, true);
    document.removeEventListener("focusin", hint, true);
    swallowClick = false;
  };
}

/** 全站原生浮层及按钮悬浮提示；不扫描或改写业务状态。 */
export function useAppInteractions() {
  useEffect(retainInteractions, []);
}

/** 默认由最上层独占关闭手势；原位确认可透传外点，Escape 仍只关闭最上层。 */
export function useDismissableLayer(ref: RefObject<HTMLElement | null>, open: boolean, onDismiss: (reason: DismissReason) => void, { consumeOutside = true }: { consumeOutside?: boolean } = {}) {
  const dismissRef = useRef(onDismiss);
  useLayoutEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const layer: RegisteredLayer = { ref, order: ++sequence, consumeOutside, dismiss: reason => {
      dismissRef.current(reason);
      if ((reason !== "outside" || consumeOutside) && previous instanceof HTMLElement && previous.isConnected && !ref.current?.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    } };
    layers.add(layer);
    const release = retainInteractions();
    return () => { layers.delete(layer); release(); };
  }, [open, ref, consumeOutside]);
}
