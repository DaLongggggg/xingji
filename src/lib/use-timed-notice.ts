"use client";

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

/** 操作轻提示：相同文案重新计时，替换和卸载不留下旧计时。 */
export function useTimedNotice(): [string | undefined, Dispatch<SetStateAction<string | undefined>>] {
  const [entry, setEntry] = useState<{ message: string }>();
  const setNotice = useCallback<Dispatch<SetStateAction<string | undefined>>>(next => {
    setEntry(previous => {
      const message = typeof next === "function" ? next(previous?.message) : next;
      return message === undefined ? undefined : { message };
    });
  }, []);
  useEffect(() => {
    if (!entry) return;
    const timer = setTimeout(() => setEntry(current => current === entry ? undefined : current), 2000);
    return () => clearTimeout(timer);
  }, [entry]);
  return [entry?.message, setNotice];
}
