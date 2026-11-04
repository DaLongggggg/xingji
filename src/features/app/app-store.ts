"use client";
import { create } from "zustand";

export type AppView = "home" | "record" | "notebook" | "settings";

type AppState = {
  activeView: AppView;
  setActiveView: (view: AppView) => void;
};

export const useAppStore = create<AppState>((set) => ({
  activeView: "home",
  setActiveView: (activeView) => set({ activeView })
}));

/**
 * 笔记本页注册的离页保存守卫。放在模块里而不是组件 ref：
 * 导航闸门在**导航发生时**读取它，渲染期不需要把 ref 传出去，也不受闭包旧值影响。
 */
let notebookLeaveGuard: (() => Promise<boolean>) | null = null;

export function setNotebookLeaveGuard(guard: (() => Promise<boolean>) | null): void {
  notebookLeaveGuard = guard;
}

export function getNotebookLeaveGuard(): (() => Promise<boolean>) | null {
  return notebookLeaveGuard;
}

/** 工作台离页守卫：提交未保存内容，失败则不离开（复用同一个导航闸门）。 */
let workbenchLeaveGuard: (() => Promise<boolean>) | null = null;

export function setWorkbenchLeaveGuard(guard: (() => Promise<boolean>) | null): void {
  workbenchLeaveGuard = guard;
}

export function getWorkbenchLeaveGuard(): (() => Promise<boolean>) | null {
  return workbenchLeaveGuard;
}
