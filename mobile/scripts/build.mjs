import { build } from "esbuild";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
await build({ entryPoints: [fileURLToPath(new URL("src/main.ts", root))], bundle: true, format: "iife", outfile: fileURLToPath(new URL("www/app.js", root)) });
await copyFile(new URL("../src/app/icon.svg", root), new URL("www/icon.svg", root));
const { version, versionCode } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isSafeInteger(versionCode) || versionCode < 1) throw Error("App版本配置无效");
for (const [relative, update] of [
  ["android/app/build.gradle", text => text.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`).replace(/versionName\s+"[^"]+"/, `versionName "${version}"`)],
  ["ios/App/App.xcodeproj/project.pbxproj", text => text.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`).replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${versionCode};`)]
]) {
  const file = new URL(relative, root);
  let text;
  try { text = await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
  await writeFile(file, update(text));
}
console.log("App连接入口与品牌资源已生成。");
