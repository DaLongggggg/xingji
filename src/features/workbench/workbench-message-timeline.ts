import type { WorkbenchStreamEvent } from "@/features/ai/stream-events";
import type { WorkbenchMessage, WorkbenchMessageBlock } from "./workbench-types";
import { stageProcess } from "./workbench-process";

/** 展示投影只消费事件顺序，不参与 Agent 决策或工具执行。 */
export function appendTimelineEvent(message: WorkbenchMessage, event: WorkbenchStreamEvent): Pick<WorkbenchMessage, "blocks" | "eventSequence" | "process"> {
  const previous = message.eventSequence ?? 0;
  const sequence = event.sequence ?? previous + 1;
  if (sequence <= previous) return { blocks: message.blocks ?? [], eventSequence: previous };
  const blocks = [...(message.blocks ?? [])];
  const base = { id: `event-${sequence}`, sequence };
  const last = blocks.at(-1);
  const addText = (type: "text" | "reasoning", text: string) => {
    if (!text) return;
    const phase = type === "text" && message.process ? message.process.phase === "answering" ? "answer" as const : "work" as const : undefined;
    if (last?.type === type && last.endSequence === previous && sequence === previous + 1 && (type !== "text" || last.type === "text" && last.phase === phase)) {
      blocks[blocks.length - 1] = { ...last, text: last.text + text, endSequence: sequence };
    } else blocks.push({ ...base, type, text, endSequence: sequence, ...(phase ? { phase } : {}) });
  };
  switch (event.type) {
    case "text": case "reasoning": addText(event.type, event.delta); break;
    case "stage":
      // 工具执行状态由卡片承载；规划预算不是用户的任务进度。
      if (event.stage !== "planning" && event.stage !== "tool") blocks.push({ ...base, type: "trace", text: `阶段：${event.label}` });
      break;
    case "notice": blocks.push({ ...base, type: "trace", text: event.message }); break;
    case "usage": blocks.push({ ...base, type: "trace", text: `用量：输入 ${event.inputTokens ?? "?"} / 输出 ${event.outputTokens ?? "?"}` }); break;
    case "error": blocks.push({ ...base, type: "trace", text: `错误：${event.message}` }); break;
    case "tool_call": case "tool_result":
      if (!blocks.some(block => block.type === "tool" && block.toolId === event.id)) blocks.push({ ...base, type: "tool", toolId: event.id });
      break;
    case "call":
      // 制图调用用量归入既有服务卡，避免再显示一份执行/完成日志。
      if (event.call.stage !== "image" && !blocks.some(block => block.type === "call" && block.callId === event.call.callId))
        blocks.push({ ...base, type: "call", callId: event.call.callId });
      break;
    case "image_result":
      if (!blocks.some(block => block.type === "images" && block.attachmentIds.includes(event.attachment.id)))
        blocks.push({ ...base, type: "images", attachmentIds: [event.attachment.id] });
      break;
  }
  return { blocks, eventSequence: sequence,
    ...(event.type === "stage" && message.process ? { process: stageProcess(message.process, event) } : {}) };
}

/** 本地终态说明/非流式产物也进入相同序列，在保存之前补齐。 */
export function completeMessageTimeline(message: WorkbenchMessage): WorkbenchMessage {
  if (message.role !== "assistant") return message;
  if (message.status === "pending" && !message.process?.outcome) return { ...message, blocks: message.blocks ?? [], eventSequence: message.eventSequence ?? 0 };
  const completionId = `completion-${message.id}`;
  const previousCompletion = (message.blocks ?? []).find(block => block.id === completionId);
  const blocks = (message.blocks ?? []).filter(block => block.id !== completionId && (block.type !== "result" || block.resultId === message.result?.id));
  // 未发出回答阶段的当前适配器：只在明确结束后交付最后一段文字，保留此前工作说明。
  if (message.process && message.process.phase !== "answering") {
    const lastText = blocks.findLastIndex(block => block.type === "text");
    const block = blocks[lastText];
    if (block?.type === "text" && block.phase === "work") blocks[lastText] = { ...block, phase: "answer" };
  }
  // done 已明确交付流正文；适配器尚未返回时不把临时图片进度补作最终正文。
  if (message.status === "pending") return { ...message, blocks };
  let sequence = message.eventSequence ?? 0;
  const base = () => ({ id: `event-${++sequence}`, sequence });
  for (const tool of message.tools ?? []) {
    if (!blocks.some(block => block.type === "tool" && block.toolId === tool.id)) blocks.push({ ...base(), type: "tool", toolId: tool.id });
  }
  const missingImages = (message.attachments ?? []).filter(image => !blocks.some(block => block.type === "images" && block.attachmentIds.includes(image.id)));
  if (missingImages.length) blocks.push({ ...base(), type: "images", attachmentIds: missingImages.map(image => image.id) });
  if (message.result?.kind === "image" && (!(message.result.dataUrl || message.result.fileRef) || !(message.attachments?.length))
    && !blocks.some(block => block.type === "result" && block.resultId === message.result?.id))
    blocks.push({ ...base(), type: "result", resultId: message.result.id });
  const textBlocks = blocks.filter(block => block.type === "text");
  const streamed = textBlocks.map(block => block.text).join("");
  if (message.text && message.text !== streamed && !streamed.endsWith(message.text)) {
    const suffix = message.text.startsWith(streamed) ? message.text.slice(streamed.length) : message.text;
    const position = previousCompletion && blocks.every(block => block.sequence < previousCompletion.sequence) ? previousCompletion : base();
    blocks.push({ id: completionId, sequence: position.sequence, type: "text", text: suffix,
      endSequence: position.sequence, ...(message.process ? { phase: "answer" as const } : {}) });
  }
  return { ...message, blocks, eventSequence: sequence };
}

/** 重试撤下本地收尾提示；真正的流式文字与已交付媒体、过程记录继续保留。 */
export function retryMessageContent(message: WorkbenchMessage): Pick<WorkbenchMessage, "text" | "blocks"> {
  const blocks = message.blocks?.filter(block => block.id !== `completion-${message.id}`);
  return { blocks, text: (blocks ?? []).flatMap(block => block.type === "text" ? [block.text] : []).join("") };
}

/** Current messages carry their own timeline; historical aggregates are not reconstructed. */
export function messageTimeline(message: WorkbenchMessage): WorkbenchMessageBlock[] {
  return message.blocks ?? [];
}
