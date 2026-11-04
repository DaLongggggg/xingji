import type { QuickNoteCandidate } from "./workbench-types";

/** 关键词打分：真实的本地检索逻辑（不是模型），用于「AI 查找随记」的候选排序原型。 */
export function scoreQuickNotes(
  query: string,
  notes: { id: string; text: string; createdAt: string }[]
): QuickNoteCandidate[] {
  const terms = query
    .split(/[\s,，。;；、]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  return notes
    .map((note) => {
      const text = note.text ?? "";
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      return { id: note.id, text, createdAt: note.createdAt, score };
    })
    .filter((candidate) => candidate.text.trim().length > 0)
    .sort((a, b) => b.score - a.score || (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 6);
}
