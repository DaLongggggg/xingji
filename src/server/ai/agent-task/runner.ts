/**
 * T7 任务宿主运行器：实现已并入 store.ts（宿主与领取/租约/计费登记/收尾共用
 * 同一参数化边界，避免跨文件导出链；Ponytail：无新文件、无第二份状态）。
 * 本文件保留为薄 re-export，维持 http.ts 的既有 import 路径。
 */
export { ensureAgentTaskHost, freezeTaskBindings, resolveTaskCredential } from "./store";
