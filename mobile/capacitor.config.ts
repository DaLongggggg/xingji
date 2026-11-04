import type { CapacitorConfig } from "@capacitor/cli";

// Run scripts/set-server.mjs with the exact service URL before syncing native resources.
const config: CapacitorConfig = {
  appId: "com.xingji.beta.integration",
  appName: "行迹",
  webDir: "www",
  loggingBehavior: "none",
  android: { allowMixedContent: true },
  server: { androidScheme: "https", cleartext: true, allowNavigation: [] }
};

export default config;
