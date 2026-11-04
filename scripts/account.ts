/**
 * 服务账户管理 CLI。管理员是在服务器主机上运行命令的人。
 * 与 HTTP 认证共用 beta-data/auth-store 实现；密码仅终端输出一次，不进日志/文件。
 *
 * 命令：
 *   init                                   初始化 beta 根与 service.sqlite（幂等；非空未知目录拒绝）
 *   account create <username>              创建普通用户，随机密码仅输出一次
 *   account list                           用户与在效会话摘要
 *   account disable|enable <username>
 *   account reset-password <username>      新随机密码 + 撤销该用户全部会话
 *   account revoke-sessions <username> [--device <label>]
 */
import { initBetaRoot, resolveBetaRoot, betaRootStatus } from "../src/server/ai/beta-data.ts";
import { createUser, listUsers, setUserStatus, resetPassword, revokeSessions, serviceDb, closeServiceDb } from "../src/server/ai/auth-store.ts";

function fail(message: string): never {
  console.error(`ERROR ${message}`);
  process.exit(1);
}
function emit(value: unknown): void {
  console.log(JSON.stringify(value));
}

const argv = process.argv.slice(2);
const command = argv[0];
const args = argv.slice(1);

try {
  if (command === "init") {
    const result = initBetaRoot();
    emit({ ok: true, root: result.root, serverId: result.serverId, created: result.created, note: "服务数据目录已就绪；用 account create 创建账户" });
  } else if (command === "account") {
    const sub = args[0];
    const root = resolveBetaRoot();
    const status = betaRootStatus(root);
    if (!status.initialized) fail("beta 根未初始化：先运行 account init");
    const db = serviceDb();
    switch (sub) {
      case "create": {
        const username = args[1];
        if (!username) fail("用法：account create <username>");
        emit({ ok: true, ...createUser(db, username), note: "password shown once" });
        break;
      }
      case "list":
        emit({ ok: true, users: listUsers(db) });
        break;
      case "disable":
      case "enable": {
        const username = args[1];
        if (!username) fail(`用法：account ${sub} <username>`);
        emit({ ok: setUserStatus(db, username, sub === "disable" ? "disabled" : "active"), username, status: sub });
        break;
      }
      case "reset-password": {
        const username = args[1];
        if (!username) fail("用法：account reset-password <username>");
        const result = resetPassword(db, username);
        if (!result) fail("用户不存在");
        emit({ ok: true, username, password: result.password, revokedAllSessions: true, note: "password shown once" });
        break;
      }
      case "revoke-sessions": {
        const username = args[1];
        const deviceFlag = args.indexOf("--device");
        const device = deviceFlag >= 0 ? args[deviceFlag + 1] : undefined;
        if (!username) fail("用法：account revoke-sessions <username> [--device <label>]");
        emit({ ok: true, username, revoked: revokeSessions(db, username, device) });
        break;
      }
      default:
        fail("用法：account create|list|disable|enable|reset-password|revoke-sessions ...");
    }
  } else {
    fail("用法：account.ts init | account <subcommand> ...");
  }
} catch (error) {
  fail(String((error as Error)?.message || error));
} finally {
  closeServiceDb();
}
