#!/usr/bin/env node
/**
 * `npx cap add ios/android` 之后的原生工程补丁（内测边界，任务书 §2.3）：
 * - Android：application 增加 usesCleartextTraffic、allowBackup=false；确保 INTERNET 权限。
 * - iOS：Info.plist 增加 NSLocalNetworkUsageDescription、NSAppTransportSecurity(NSAllowsArbitraryLoads)。
 * 幂等：重复执行不重复插入。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const target = process.argv[2] || "all";

function patchAndroid() {
  const file = path.join(root, "android", "app", "src", "main", "AndroidManifest.xml");
  if (!existsSync(file)) return console.log("skip android（未生成）");
  let xml = readFileSync(file, "utf8");
  if (!xml.includes("android.permission.INTERNET")) {
    xml = xml.replace("<application", '<uses-permission android:name="android.permission.INTERNET" />\n    <application');
  }
  if (!xml.includes("android:usesCleartextTraffic")) {
    xml = xml.replace(/<application\b/, '<application\n        android:usesCleartextTraffic="true"');
  }
  if (!xml.includes("android:allowBackup")) {
    xml = xml.replace(/<application\b/, '<application\n        android:allowBackup="false"');
  } else {
    xml = xml.replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"');
  }
  writeFileSync(file, xml);
  console.log("android manifest patched（cleartext=true, allowBackup=false）");
}

function patchIos() {
  const file = path.join(root, "ios", "App", "App", "Info.plist");
  if (!existsSync(file)) return console.log("skip ios（未生成）");
  let plist = readFileSync(file, "utf8");
  const inject = `	<key>NSLocalNetworkUsageDescription</key>
	<string>行迹内测需要访问你指定的局域网服务器以同步笔记与 AI 任务。</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
</dict>`;
  if (!plist.includes("NSLocalNetworkUsageDescription")) {
    // 插在最后一个 </dict>（根 dict 结束）之前。
    const idx = plist.lastIndexOf("</dict>");
    plist = plist.slice(0, idx) + inject + plist.slice(idx + "</dict>".length);
    writeFileSync(file, plist);
    console.log("ios Info.plist patched（LocalNetwork + ATS 例外）");
  } else {
    console.log("ios Info.plist already patched");
  }
}

if (target === "android" || target === "all") patchAndroid();
if (target === "ios" || target === "all") patchIos();
