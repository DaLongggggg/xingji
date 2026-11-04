"use client";

import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MARKDOWN_WORKER_THRESHOLD, parseMarkdownDocument, type MarkdownDocument } from "./workbench-markdown-document";
import type { MarkdownWorkerReply } from "./workbench-markdown.worker";

type TextBlock = { id: string; text: string };
export type MarkdownDisplay = { text: string; document?: MarkdownDocument; pending?: boolean; degraded?: boolean; blockLimit?: number; tail?: string; beforeChange?: () => void; afterChange?: () => void };
export type MarkdownDisplays = ReadonlyMap<string, MarkdownDisplay>;
type Job = { id: number; owner: symbol; text: string; receive: (document?: MarkdownDocument, degraded?: boolean) => void };
const owners = new Set<symbol>();
const pending = new Map<symbol, Job>();
let worker: Worker | undefined, inFlight: Job | undefined, sequence = 0;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let workerFailed = false;

function stopWorker() {
  worker?.terminate(); worker = undefined;
  if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
  fallbackTimer = undefined;
  if (watchdog !== undefined) clearTimeout(watchdog);
  watchdog = undefined; inFlight = undefined;
}
function finish(job: Job, document?: MarkdownDocument, degraded = false) {
  if (inFlight !== job) return;
  inFlight = undefined;
  if (watchdog !== undefined) clearTimeout(watchdog);
  watchdog = undefined;
  // Superseded requests never replace a newer version; only the latest pending text is retained.
  if (owners.has(job.owner)) job.receive(document, degraded);
  pump();
}
function pump() {
  if (inFlight || !pending.size) return;
  const job = pending.values().next().value!;
  pending.delete(job.owner); inFlight = job;
  const fallback = () => {
    // A failed Worker never schedules a giant synchronous main-thread parse.
    fallbackTimer = setTimeout(() => { fallbackTimer = undefined; finish(job, undefined, true); }, 0);
  };
  if (workerFailed || typeof Worker === "undefined") { fallback(); return; }
  if (!worker) {
    try {
      worker = new Worker(new URL("./workbench-markdown.worker.ts", import.meta.url), { type: "module" });
      const created = worker;
      worker.onmessage = ({ data }: MessageEvent<MarkdownWorkerReply>) => {
        if (worker !== created) return;
        const current = inFlight;
        if (!current || data.id !== current.id) return;
        if (watchdog !== undefined) clearTimeout(watchdog);
        watchdog = undefined;
        if (data.error || !data.document || data.document.text !== current.text) {
          workerFailed = true; worker?.terminate(); worker = undefined;
          inFlight = undefined;
          if (owners.has(current.owner)) pending.set(current.owner, pending.get(current.owner) ?? current);
          pump();
        } else finish(current, data.document);
      };
      worker.onerror = event => {
        if (worker !== created) return;
        event.preventDefault();
        if (watchdog !== undefined) clearTimeout(watchdog);
        watchdog = undefined; workerFailed = true; worker?.terminate(); worker = undefined;
        const current = inFlight; inFlight = undefined;
        if (current && owners.has(current.owner)) pending.set(current.owner, pending.get(current.owner) ?? current);
        pump();
      };
    } catch { workerFailed = true; fallback(); return; }
  }
  watchdog = setTimeout(() => {
    watchdog = undefined;
    if (inFlight !== job) return;
    workerFailed = true; worker?.terminate(); worker = undefined;
    fallback();
  }, 10_000);
  try { worker.postMessage({ id: job.id, text: job.text }); }
  catch {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined; workerFailed = true; worker.terminate(); worker = undefined; fallback();
  }
}

/** One lazily created Worker; one in-flight parse, and only each mounted location's latest request. */
export function retainMarkdownOwner(owner: symbol) {
  owners.add(owner);
  return () => {
    owners.delete(owner); pending.delete(owner);
    if (!owners.size) { stopWorker(); pending.clear(); workerFailed = false; }
  };
}
export function requestMarkdownDocument(owner: symbol, text: string, receive: Job["receive"]) {
  if (inFlight?.owner === owner && inFlight.text === text) {
    const job = inFlight;
    pending.delete(owner);
    job.receive = receive;
    return () => { if (job.receive === receive) job.receive = () => undefined; };
  }
  const job = { id: ++sequence, owner, text, receive };
  pending.set(owner, job); pump();
  return () => {
    if (pending.get(owner) === job) pending.delete(owner);
    if (inFlight === job) job.receive = () => undefined;
  };
}

/** Display-only preparation: the returned text/tree/refs always belong to the same version. */
export function WorkbenchMarkdownDocuments({ blocks, children, onBeforeChange, onAfterChange }: {
  blocks: readonly TextBlock[];
  children: (documents: MarkdownDisplays) => ReactNode;
  onBeforeChange?: () => void;
  onAfterChange?: () => void;
}) {
  const owner = useMemo(() => Symbol("markdown"), []);
  const [limits, setLimits] = useState(new Map<string, { text: string; count: number }>());
  const [ready, setReady] = useState(new Map<string, MarkdownDisplay>());
  const [shortDocuments, setShortDocuments] = useState(new Map<string, MarkdownDocument>());
  const sourceTexts = new Map(blocks.map(block => [block.id, block.text]));
  const retainedLimits = new Map([...limits].filter(([id, value]) => sourceTexts.get(id)?.startsWith(value.text)));
  if (retainedLimits.size !== limits.size) setLimits(retainedLimits);
  const nextShort = new Map<string, MarkdownDocument>();
  for (const block of blocks) {
    const previous = shortDocuments.get(block.id);
    if (block.text.length < MARKDOWN_WORKER_THRESHOLD)
      nextShort.set(block.id, previous?.text === block.text ? previous : parseMarkdownDocument(block.text));
    else if (previous && block.text.startsWith(previous.text)) nextShort.set(block.id, previous);
  }
  const unchanged = nextShort.size === shortDocuments.size && [...nextShort].every(([id, document]) => shortDocuments.get(id) === document);
  const currentShort = unchanged ? shortDocuments : nextShort;
  // Keep one version per mounted position, including the last short tree when a stream crosses the threshold.
  if (!unchanged) setShortDocuments(nextShort);
  const callbacks = useRef({ onBeforeChange, onAfterChange });
  useLayoutEffect(() => { callbacks.current = { onBeforeChange, onAfterChange }; });
  // Locations live until removal/unmount, rather than being cancelled on every incoming delta.
  const locations = useRef(new Map<string, { owner: symbol; release: () => void; text: string }>());
  const currentBlocks = useRef(blocks);
  useLayoutEffect(() => { currentBlocks.current = blocks; });
  useEffect(() => retainMarkdownOwner(owner), [owner]);
  useEffect(() => {
    const current = new Set<string>();
    for (const { id, text } of blocks) {
      if (text.length < MARKDOWN_WORKER_THRESHOLD) continue;
      current.add(id);
      let location = locations.current.get(id);
      if (!location) {
        const token = Symbol(id);
        location = { owner: token, release: retainMarkdownOwner(token), text: "" };
        locations.current.set(id, location);
      }
      if (location.text === text) continue;
      location.text = text;
      requestMarkdownDocument(location.owner, text, (document, degraded) => {
        const latest = currentBlocks.current.find(block => block.id === id)?.text;
        if (latest === undefined || !latest.startsWith(text)) return;
        callbacks.current.onBeforeChange?.();
        startTransition(() => setReady(previous => {
          const old = previous.get(id);
          if (old && old.text.startsWith(text) && old.text.length > text.length) return previous;
          if (document && old?.document) {
            const prior = new Map(old.document.blocks.map(block => [block.key, block]));
            document = { ...document, blocks: document.blocks.map(block => {
              const existing = prior.get(block.key);
              return existing?.fingerprint === block.fingerprint && existing.table?.raw === block.table?.raw ? existing : block;
            }) };
          }
          return new Map(previous).set(id, { text, ...(document ? { document } : {}), ...(degraded ? { degraded: true } : {}) });
        }));
      });
    }
    for (const [id, location] of locations.current) if (!current.has(id)) {
      location.release(); locations.current.delete(id);
      setReady(previous => { if (!previous.has(id)) return previous; const next = new Map(previous); next.delete(id); return next; });
    }
  }, [blocks]);
  useEffect(() => {
    const mounted = locations.current;
    return () => { for (const location of mounted.values()) location.release(); mounted.clear(); };
  }, []);
  useLayoutEffect(() => { callbacks.current.onAfterChange?.(); }, [ready, limits]);
  const displays = useMemo(() => {
    const result = new Map<string, MarkdownDisplay>();
    for (const block of blocks) {
      if (block.text.length < MARKDOWN_WORKER_THRESHOLD) {
        result.set(block.id, { text: block.text, document: currentShort.get(block.id), beforeChange: onBeforeChange, afterChange: onAfterChange });
      } else {
        const lastShort = currentShort.get(block.id), latest = ready.get(block.id);
        const previous = latest && block.text.startsWith(latest.text) ? latest
          : lastShort ? { text: lastShort.text, document: lastShort } : undefined;
        result.set(block.id, previous && block.text.startsWith(previous.text)
          ? { ...previous, pending: previous.text !== block.text, tail: block.text.slice(previous.text.length), beforeChange: onBeforeChange, afterChange: onAfterChange }
          : { text: block.text, pending: true, beforeChange: onBeforeChange, afterChange: onAfterChange });
      }
    }
    for (const [id, display] of result) {
      const document = display.document;
      if (!document) continue;
      const previous = limits.get(id);
      const count = Math.min(document.blocks.length, document.text.length < MARKDOWN_WORKER_THRESHOLD ? document.blocks.length : previous && document.text.startsWith(previous.text) ? previous.count : 8);
      const end = document.blocks[count - 1]?.end ?? 0;
      result.set(id, { ...display, blockLimit: count,
        // Media projection and rich mounting advance in the very same React commit.
        document: { ...document, references: document.references.filter(reference => count === document.blocks.length || reference.offset < end) } });
    }
    return result;
  }, [blocks, ready, currentShort, limits, onBeforeChange, onAfterChange]);
  useEffect(() => {
    const next = [...displays].find(([, display]) => display.document && (display.blockLimit ?? 0) < display.document.blocks.length);
    if (!next) return;
    const [id, display] = next, document = display.document!;
    const frame = requestAnimationFrame(() => {
      callbacks.current.onBeforeChange?.();
      // A small fixed batch keeps the same bounded work on desktop and native WebViews.
      const count = Math.min(8, document.blocks.length - (display.blockLimit ?? 0));
      startTransition(() => setLimits(previous => new Map(previous).set(id, { text: document.text, count: (display.blockLimit ?? 0) + count })));
    });
    return () => cancelAnimationFrame(frame);
  }, [displays]);
  return children(displays);
}
