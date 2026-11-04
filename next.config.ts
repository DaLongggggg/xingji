import type { NextConfig } from "next";
import path from "node:path";
import { DevAtomicManifestsPlugin } from "./src/lib/dev-atomic-manifests";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      process.env.NODE_ENV === "development"
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://webapi.amap.com https://*.amap.com"
        : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://webapi.amap.com https://*.amap.com",
      "style-src 'self' 'unsafe-inline' https://*.amap.com",
      // Search previews use validated external HTTPS image URLs; scripts/connect remain separate.
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' blob: data: https://restapi.amap.com https://*.amap.com https://s3.amazonaws.com",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join("; ")
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" }
];

const nextConfig: NextConfig = {
  // 桌面Web与其他已运行的开发入口隔离编译缓存，避免共享锁和旧资源互相覆盖。
  distDir: process.env.XINGJI_NEXT_DIST_DIR || ".next",
  // 生产仍严格检查所有应用源码；测试夹具留在原有 tsconfig 的独立检查范围。
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // 开发资源允许所有 192.168.x.x 局域网地址，供手机在本机 IP 变化后继续预览。
  allowedDevOrigins: ["192.168.*.*", "127.0.0.1"],
  // Keep development chrome from covering send/cancel in Web and native WebViews.
  devIndicators: false,
  poweredByHeader: false,
  reactStrictMode: true,
  webpack(config, { dev, isServer, webpack }) {
    if (dev) config.plugins.push(new DevAtomicManifestsPlugin());
    if (!isServer) {
      // The parser's browser export requires document; the same package's worker/default entry uses its entity table.
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(
        /[/\\]decode-named-character-reference[/\\]index\.dom\.js$/,
        "index.js"
      ));
    }
    if (dev && !isServer) {
      // Next 16.2 的默认回收未等待新 CSS 加载，会在慢请求期间暴露无样式页面。
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(
        /(?:^|[/\\])app-link-gc(?:\.js)?$/,
        path.resolve(process.cwd(), "src/lib/dev-style-gc.ts")
      ));
    }
    return config;
  },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      ...["https://localhost", "capacitor://localhost"].map(origin => ({
        source: "/api/:path*",
        has: [{ type: "header" as const, key: "origin", value: origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }],
        headers: [
          { key: "Access-Control-Allow-Origin", value: origin },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, X-Xingji-Dataset" },
          { key: "Vary", value: "Origin" }
        ]
      }))
    ];
  }
};

export default nextConfig;
