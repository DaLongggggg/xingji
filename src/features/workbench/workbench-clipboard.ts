/** Copy during the initiating click, including native LAN HTTP pages without ClipboardAPI. */
export async function copyWorkbenchText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try the current user gesture. */ }
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const input = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : undefined;
  const inputSelection = input ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : undefined;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const scroll: { element: HTMLElement; top: number; left: number }[] = [];
  for (let element = active; element; element = element.parentElement ?? undefined)
    scroll.push({ element, top: element.scrollTop, left: element.scrollLeft });
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-label", "复制内容");
  field.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  // A textarea outside the active modal is inert and cannot acquire a selection.
  (active?.closest("dialog[open]") ?? document.querySelector("dialog[open]") ?? document.body).append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard copy unavailable");
  } finally {
    field.remove();
    if (active?.isConnected) active.focus({ preventScroll: true });
    if (input?.isConnected && inputSelection && inputSelection.start !== null && inputSelection.end !== null)
      input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
    if (selection && ranges.length) {
      selection.removeAllRanges();
      for (const range of ranges) if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range);
    }
    for (const { element, top, left } of scroll) if (element.isConnected) { element.scrollTop = top; element.scrollLeft = left; }
  }
}
