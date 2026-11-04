#!/usr/bin/env node
/**
 * 生成 mobile/www/server-config.js（修复任务书 §3：自检账号配置限制于隔离临时目录，
 * 默认不向可分发 www 写任何账号/密码；地址为非秘密，可单独配置）。
 *
 * 用法：
 *   node scripts/set-server.mjs <serverBaseUrl>                       # 仅写地址（accounts: []）
 *   node scripts/set-server.mjs <serverBaseUrl> --accounts-out <file> user1 pass1 [user2 pass2 ...]
 *       # 完整配置（含账号）只写入 <file>；拒绝写到 mobile/www、mobile/android、mobile/ios 内
 *       # <file> 供隔离测试安装的临时静态副本使用，用后应删除
 */
import { writeFileSync, readFileSync, realpathSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, "..");
const [, , server, ...rest] = process.argv;
if (!server || !/^https?:\/\//.test(server)) {
  console.error("usage: node scripts/set-server.mjs <serverBaseUrl> [--accounts-out <file> user pass ...]");
  process.exit(1);
}
// 拒绝携带用户名密码的服务地址（P2-7 复核修复）；日志只输出 host 与路径。
let parsed;
try {
  parsed = new URL(server);
} catch {
  console.error("服务地址无法解析");
  process.exit(1);
}
if (parsed.username || parsed.password || parsed.search || parsed.hash) {
  console.error("拒绝包含用户名密码、query 或 fragment 的服务地址");
  process.exit(1);
}
const cleanBase = parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
const displayBase = parsed.host + parsed.pathname;
const accountsFlag = rest.indexOf("--accounts-out");
let accounts = [];
if (accountsFlag >= 0) {
  const outFile = rest[accountsFlag + 1];
  const creds = rest.slice(accountsFlag + 2);
  if (!outFile || creds.length === 0 || creds.length % 2 !== 0) {
    console.error("--accounts-out 需要文件路径和成对的 user pass");
    process.exit(1);
  }
  const resolved = path.resolve(outFile);
  const inside = [path.join(mobileRoot, "www"), path.join(mobileRoot, "android"), path.join(mobileRoot, "ios")];
  // 符号链接一律拒绝（含悬空链接：existsSync 对其返回 false，但写入仍会跟随链接，
  // P2-7 复核二轮修复）；真实文件再解析真实目标判断保护目录。
  let outStat = null;
  try {
    outStat = lstatSync(resolved);
  } catch {
    /* 不存在：将新建普通文件 */
  }
  if (outStat && outStat.isSymbolicLink()) {
    console.error("拒绝把账号配置输出到符号链接");
    process.exit(1);
  }
  if (outStat && !outStat.isFile()) {
    console.error("输出目标不是普通文件");
    process.exit(1);
  }
  if (outStat) {
    let realFile = resolved;
    try {
      realFile = realpathSync(resolved);
    } catch {
      console.error("输出文件无法解析真实路径");
      process.exit(1);
    }
    for (const dir of inside) {
      try {
        if (realFile.startsWith(realpathSync(dir))) {
          console.error(`拒绝把账号配置写入可分发/生成目录（符号链接指向）：${dir}`);
          process.exit(1);
        }
      } catch {
        /* 目录不存在则不构成限制 */
      }
    }
  }
  for (const dir of inside) {
    try {
      if (realpathSync(path.dirname(resolved)).startsWith(realpathSync(dir))) {
        console.error(`拒绝把账号配置写入可分发/生成目录：${dir}`);
        process.exit(1);
      }
    } catch {
      /* 目录不存在则不构成限制 */
    }
  }
  for (let i = 0; i < creds.length; i += 2) accounts.push({ username: creds[i], password: creds[i + 1] });
  writeFileSync(resolved, `window.__XINGJI_BETA_CONFIG__ = ${JSON.stringify({ server: cleanBase, accounts }, null, 2)};\n`);
  console.log(`written ${outFile} → ${displayBase} (${accounts.length} accounts, isolated file)`);
}
writeFileSync(
  path.join(mobileRoot, "www", "server-config.js"),
  `// 非秘密运行时配置：仅服务器地址。账号/密码只允许写入隔离临时副本（--accounts-out）。\nwindow.__XINGJI_BETA_CONFIG__ = ${JSON.stringify({ server: cleanBase, accounts: [] }, null, 2)};\n`
);
// T4：把同一精确 origin 写入 capacitor.config.ts 的 server.allowNavigation（官方机制，
// 让 Capacitor 桥通道覆盖受信 origin；禁止通配——这里只写当前传入的这一个地址）。
const capConfigPath = path.join(mobileRoot, "capacitor.config.ts");
let capConfig = readFileSync(capConfigPath, "utf8");
const allowLine = `    allowNavigation: [${JSON.stringify(cleanBase)}]`;
if (/allowNavigation: \[[^\]]*\]/.test(capConfig)) {
  capConfig = capConfig.replace(/allowNavigation: \[[^\]]*\]/, allowLine);
} else {
  capConfig = capConfig.replace(/(server: \{)/, `$1\n${allowLine}`);
}
writeFileSync(capConfigPath, capConfig);
console.log(`written capacitor.config.ts allowNavigation → ${displayBase} (exact origin, no wildcard)`);
