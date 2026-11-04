# 行迹 App

行迹 App 使用与 Web 相同的服务，提供地图、图文笔记和 AI 工作台。笔记、照片、会话与记忆保存在设备中，登录信息由系统安全保管；登录与 AI 功能需要连接行迹服务。

本目录提供 iOS、Android 工程和原生插件源码。安装包需自行构建，iOS 真机安装还需开发者签名。使用方法见[用户说明](../user-guide.md)，服务部署见[安装说明](../docs/installation.md)，资源来源见[第三方说明](../docs/third-party.md)。

## 准备

先按安装说明配置根目录服务，再安装根目录和 App 的依赖：

```bash
# 在仓库根目录
pnpm install --frozen-lockfile
cd mobile
npm ci
```

设置设备能够访问的服务器 URL：

```bash
node scripts/set-server.mjs <服务器URL>
```

这会写入本地连接配置和精确的受信服务地址，不包含账号、密码或模型密钥。地址变更后需重新同步、构建。正式部署应使用 HTTPS。

使用下面的同步命令更新资源和依赖；不要运行 `cap add` 覆盖仓库中的工程。

## iOS

需要 macOS、完整 Xcode，最低支持 iOS 15。在 `mobile/` 目录运行：

```bash
npm run sync:ios
open ios/App/App.xcodeproj
```

在 Xcode 中选择模拟器或设备。安装到真机前，配置自己的开发者签名；如需分发，使用对应的签名与归档流程。`cap sync` 会重新生成插件依赖配置，不要手改生成的 `CapApp-SPM/Package.swift`。

## Android

需要 Java 21 与 Android SDK。`JAVA_HOME` 应指向 Java 21，SDK 通过 `ANDROID_HOME` 或本机 `android/local.properties` 指定；本机路径配置不上传。在 `mobile/` 目录运行：

```bash
npm run build
npx cap sync android
npm run prepare-native -- android
cd android
./gradlew :app:assembleDebug
```

调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。对外分发前需配置自己的发布签名并构建对应版本。

## 连接与数据

打开 App 后填写服务地址和账户，阅读隐私协议并选择 AI、图片许可。登录成功或恢复有效会话后会直接进入工作区。模型配置属于服务账户；登录同一账户不会自动同步设备中的笔记和照片。

更新 App 时请沿用原应用标识和签名，采用覆盖安装。卸载会清除本机资料，升级前建议先备份。

备份与恢复、模型设置和图片操作见[用户说明](../user-guide.md)。请自行保管账户资料、签名材料与服务器配置。
