/** Next 开发期样式交接：新资源可用后，才回收同一路径的旧版本。 */
export function linkGc(): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Map<HTMLLinkElement, () => void>();
  const styles = () => document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-precedence^="next"]');
  const resource = (link: HTMLLinkElement) => {
    const url = new URL(link.href, document.baseURI);
    const version = Number(url.searchParams.get("v"));
    url.searchParams.delete("v");
    return { key: url.href, version };
  };

  const ready = (link: HTMLLinkElement) => {
    if (!link.isConnected || !link.sheet) return;
    const current = resource(link);
    if (!Number.isFinite(current.version) || current.version <= 0) return;
    // 保留 Next 的短延迟，给字体样式一个应用周期。
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!link.isConnected || !link.sheet) return;
      for (const previous of styles()) {
        const old = resource(previous);
        if (old.key !== current.key || old.version >= current.version) continue;
        const href = previous.getAttribute("href");
        pending.get(previous)?.();
        previous.remove();
        for (const preload of document.head.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="style"]')) {
          if (preload.getAttribute("href") === href) preload.remove();
        }
      }
    }, 5);
    timers.add(timer);
  };

  const watch = (link: HTMLLinkElement) => {
    pending.get(link)?.();
    if (link.sheet) { ready(link); return; }
    const clear = () => {
      link.removeEventListener("load", loaded);
      link.removeEventListener("error", clear);
      pending.delete(link);
    };
    const loaded = () => { clear(); ready(link); };
    pending.set(link, clear);
    link.addEventListener("load", loaded);
    // 加载失败时保留已应用的旧样式。
    link.addEventListener("error", clear);
  };
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) {
      if (node instanceof HTMLLinkElement && node.rel === "stylesheet" && node.dataset.precedence?.startsWith("next")) watch(node);
    }
  });
  observer.observe(document.head, { childList: true });
  for (const link of styles()) watch(link);
  return () => {
    observer.disconnect();
    for (const timer of timers) clearTimeout(timer);
    for (const clear of pending.values()) clear();
  };
}
