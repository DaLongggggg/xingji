/**
 * 导航闸门：**全局导航与「在 AI 工作台中打开」共用同一段语义**。
 *
 * 两条规则（与 024-A 的全局导航一致）：
 * - 离开笔记本页前先跑页面注册的离页守卫（等在途草稿落库）；守卫失败/冲突就**不执行**动作，
 *   用户留在原笔记，也不会先建出一个空会话；
 * - 导航序号：连续触发时只有最后一次生效，迟到的旧回调被丢弃。
 *
 * 抽成纯函数是为了让新入口复用同一条链，并且能被定向测试覆盖（在途保存 / 保存失败 / 连续导航）。
 */
export type NavigationGate = (action: () => void) => Promise<boolean>;

export function createNavigationGate(deps: {
  /** 当前是否处在需要离页守卫的页面（笔记本）。 */
  needsLeaveGuard: () => boolean;
  /** 页面注册的守卫；未注册时按“无需等待”处理。 */
  leaveGuard: () => (() => Promise<boolean>) | null | undefined;
}): NavigationGate {
  let sequence = 0;
  return async (action) => {
    const mine = ++sequence;
    if (deps.needsLeaveGuard()) {
      const guard = deps.leaveGuard();
      if (guard) {
        const ok = await guard();
        // 迟到的结果不再影响已经更新的导航意图。
        if (mine !== sequence) return false;
        if (!ok) return false;
      }
    }
    if (mine !== sequence) return false;
    action();
    return true;
  };
}
