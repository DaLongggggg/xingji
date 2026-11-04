import type { WorkbenchMessageBlock } from "./workbench-types";

/** 公开文字直接输出，思考和工具进入过程；同一产物由首次出现的块负责。 */
export function partitionMessageBlocks(blocks: readonly WorkbenchMessageBlock[]) {
  const process: WorkbenchMessageBlock[] = [];
  const delivery: WorkbenchMessageBlock[] = [];
  const artifacts = new Set<string>();
  for (const block of blocks) {
    if (block.type === "images") {
      const attachmentIds = block.attachmentIds.filter(id => {
        if (artifacts.has(id)) return false;
        artifacts.add(id);
        return true;
      });
      if (attachmentIds.length) delivery.push({ ...block, attachmentIds });
    } else if (block.type === "result") {
      if (!artifacts.has(block.resultId)) {
        artifacts.add(block.resultId);
        delivery.push(block);
      }
    } else if (block.type === "text") {
      delivery.push(block);
    } else {
      process.push(block);
    }
  }
  return { process, delivery };
}
