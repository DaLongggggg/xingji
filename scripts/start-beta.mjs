#!/usr/bin/env node
/**
 * T1/T3 beta launcher (execution taskbook 4.1/5): the only public HTTP entry.
 *
 * - Requires an explicitly initialized beta root (exits with a CLI hint otherwise).
 * - Generates a process-private peer key, strips inbound X-Forwarded-* and
 *   x-xingji-peer headers, then forwards with an HMAC of the real socket address
 *   to the inner Next server (dev or start).
 * - Reaching the inner port directly has no key, so login is refused
 *   (PEER_UNTRUSTED); X-Forwarded-For is never trusted.
 * - Default port 3111; when busy, picks a free port in 3112-3119 and prints the
 *   actual address. Never kills the occupying process.
 * No daemon behavior: signals are forwarded to the inner process.
 */
import { createServer, request as httpRequest } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const betaRoot = process.env.XINGJI_BETA_ROOT || "";
const bindAddress = process.env.XINGJI_BIND || "0.0.0.0";
const devMode = process.env.XINGJI_BETA_DEV === "1";
const requestedPort = Number(process.env.XINGJI_BETA_PORT || 3111);
const fallbackPorts = [3112, 3113, 3114, 3115, 3116, 3117, 3118, 3119];
const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;
if (!validPort(requestedPort)) {
  console.error("ERROR invalid public port; expected an integer in 1-65535");
  process.exit(1);
}

if (!betaRoot || !path.isAbsolute(betaRoot)) {
  console.error("ERROR XINGJI_BETA_ROOT must be an absolute path");
  process.exit(1);
}
if (!existsSync(path.join(betaRoot, "beta-manifest.json"))) {
  console.error(`ERROR beta root not initialized (missing beta-manifest.json): ${betaRoot}; run: pnpm account init`);
  process.exit(1);
}

function listenFree(port, address = bindAddress) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, address);
  });
}

async function pickPort() {
  if (await listenFree(requestedPort)) return requestedPort;
  for (const candidate of fallbackPorts) {
    if (await listenFree(candidate)) {
      console.log(`BETA_PORT_FALLBACK ${candidate}`);
      return candidate;
    }
  }
  console.error("ERROR no available public port (requested plus 3112-3119); occupants are not killed");
  process.exit(1);
}

const peerKey = randomBytes(32).toString("hex");
const publicPort = await pickPort();
const internalPort = publicPort + 73;
if (!validPort(internalPort) || !(await listenFree(internalPort, "127.0.0.1"))) {
  console.error(`ERROR internal port ${internalPort} is invalid or busy; occupants are not killed`);
  process.exit(1);
}

const nextBin = path.join(repoRoot, "node_modules", ".bin", "next");
if (!existsSync(nextBin)) {
  console.error("ERROR next binary not found; run: pnpm install");
  process.exit(1);
}
const child = spawn(nextBin, [...(devMode ? ["dev", "--webpack"] : ["start"]), "--hostname", "127.0.0.1", "--port", String(internalPort)], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NODE_ENV: devMode ? "development" : "production",
    XINGJI_PEER_KEY: peerKey,
    XINGJI_BETA_ROOT: betaRoot
  },
  stdio: ["ignore", "inherit", "inherit"]
});

const waitReady = async () => {
  // HTTP 健康探测（长超时容忍 dev 首次编译）；200/503 均视为服务已就绪。
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${internalPort}/api/health`, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      /* inner server not ready yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

const stripForwardHeaders = (headers) => {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === "x-xingji-peer" || lower === "x-xingji-host") delete headers[name];
  }
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  delete headers["x-forwarded-port"];
  delete headers["x-real-ip"];
  return headers;
};

const proxyHeaders = (clientReq) => {
  const headers = stripForwardHeaders({ ...clientReq.headers });
  const peerAddress = clientReq.socket.remoteAddress || "unknown";
  headers["x-xingji-peer"] = `${peerAddress}|${createHmac("sha256", peerKey).update(peerAddress).digest("hex")}`;
  // T2a/T4 review fix 4: keep the client's original Host, HMAC-signed, so the inner
  // app can do same-origin checks against the public entry (Host itself is rewritten
  // to the internal address for Next routing). Spoofed x-xingji-host is stripped above.
  const originalHost = clientReq.headers.host;
  if (originalHost) {
    headers["x-xingji-host"] = `${originalHost}|${createHmac("sha256", peerKey).update(originalHost).digest("hex")}`;
  }
  headers.host = `127.0.0.1:${internalPort}`;
  return headers;
};

const proxyServer = createServer((clientReq, clientRes) => {
  const upstream = httpRequest(
    { host: "127.0.0.1", port: internalPort, path: clientReq.url, method: clientReq.method, headers: proxyHeaders(clientReq) },
    (upRes) => {
      clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(clientRes);
    }
  );
  upstream.on("error", () => {
    if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    clientRes.end(JSON.stringify({ ok: false, error: "BETA_UPSTREAM_UNAVAILABLE" }));
  });
  clientReq.pipe(upstream);
});

// Next 开发期的 React debug 数据也经 HMR 传入；漏转发会使页面停在 SSR 初始状态。
const upgradeSockets = new Set();
proxyServer.on("upgrade", (clientReq, clientSocket, head) => {
  if (!devMode || clientReq.url?.split("?")[0] !== "/_next/webpack-hmr") {
    clientSocket.destroy();
    return;
  }
  upgradeSockets.add(clientSocket);
  let remoteSocket;
  const upstream = httpRequest({
    host: "127.0.0.1", port: internalPort, path: clientReq.url, method: clientReq.method, headers: proxyHeaders(clientReq)
  });
  clientSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("close", () => {
    upgradeSockets.delete(clientSocket);
    upstream.destroy();
    remoteSocket?.destroy();
  });
  upstream.on("error", () => clientSocket.destroy());
  upstream.on("response", (response) => {
    response.resume();
    clientSocket.destroy();
  });
  upstream.on("upgrade", (response, socket, upstreamHead) => {
    remoteSocket = socket;
    socket.on("error", () => clientSocket.destroy());
    socket.on("close", () => clientSocket.destroy());
    let responseHeaders = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`;
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      responseHeaders += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
    }
    clientSocket.write(`${responseHeaders}\r\n`);
    if (upstreamHead.length) clientSocket.write(upstreamHead);
    if (head.length) socket.write(head);
    socket.pipe(clientSocket);
    clientSocket.pipe(socket);
  });
  upstream.end();
});

let shutdownCode;
const shutdown = (code) => {
  if (shutdownCode !== undefined) return;
  shutdownCode = code;
  for (const socket of upgradeSockets) socket.destroy();
  proxyServer.close();
  child.kill("SIGTERM");
  setTimeout(() => { child.kill("SIGKILL"); process.exit(code); }, 1500).unref();
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
child.on("exit", (code) => {
  proxyServer.close();
  process.exit(shutdownCode ?? code ?? 1);
});

proxyServer.on("error", error => {
  console.error(`ERROR public port ${publicPort} could not listen: ${error.code || error.message}; stopping own Next process`);
  shutdown(1);
});
child.on("error", error => {
  console.error(`ERROR could not start Next: ${error.message}`);
  shutdown(1);
});
// Reserve the chosen public port before waiting for Next; bind races have a bounded cleanup path.
await new Promise(resolve => proxyServer.listen(publicPort, bindAddress, resolve));

if (!(await waitReady())) {
  console.error("ERROR inner Next did not become ready in time");
  shutdown(1);
} else {
  console.log(`BETA_READY port=${publicPort} internal=${internalPort} mode=${devMode ? "dev" : "start"} root=${betaRoot}\nBETA_URL http://${bindAddress === "0.0.0.0" ? "127.0.0.1" : bindAddress}:${publicPort}`);
}
