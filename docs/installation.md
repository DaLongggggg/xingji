# 安装与配置

行迹包含 Web 界面、账户服务，以及连接该服务的 iOS/Android App 工程。先部署服务，再在浏览器或 App 中登录使用。

## 环境

- Node.js 24 或更新版本、pnpm 11；锁定版本见根目录 `package.json`。
- App 另需其原生开发环境，见 [App 说明](../mobile/README.md)。
- 地图需自备有使用权限、符合行迹目录格式的行政区数据包；模型按自己的供应商账户配置。

## 首次部署服务

在项目根目录安装依赖，并给这份服务指定独立的数据目录：

```bash
pnpm install --frozen-lockfile
export XINGJI_BETA_ROOT="$PWD/.local/service"
pnpm beta:init
pnpm account account create owner
```

创建账户时，终端会显示一次随机密码。保存该密码用于登录；源码不附带默认账户或预置密码。初始化只用于准备新服务，不要将其他服务的数据目录当作空目录重新配置。

如果已有获授权的地图包，设置其绝对路径：

```bash
export XINGJI_ATLAS_DIR="/absolute/path/to/atlas"
```

数据包须含 `manifest.json` 与清单登记的文件，且匹配当前地区目录。原始素材不会自动随源码下载；缺少数据包时，地图会提示资源未就绪，笔记和工作台仍可独立使用。

准备使用 AI 时开启服务侧能力：

```bash
export XINGJI_AI_ENABLED=1
```

随后构建并启动：

```bash
pnpm build
pnpm start:beta
```

默认入口为 `http://127.0.0.1:3111`，实际地址以终端输出为准。以后启动继续使用相同的 `XINGJI_BETA_ROOT` 和所需配置；服务数据与模型加密密钥需要一起保管。停止服务使用启动终端的 Ctrl+C。

App 需要设备可访问的服务地址；对外部署请使用 HTTPS 地址。

## 添加与管理账户

账户由服务管理员在主机上创建，应用内没有自行注册入口。使用与服务启动时相同的 `XINGJI_BETA_ROOT`，在项目根目录执行：

```bash
export XINGJI_BETA_ROOT="$PWD/.local/service"
pnpm account account create traveler
```

`traveler` 可替换为 3–32 位字母、数字、下划线或短横线组成的用户名。已有服务无需再次初始化；若使用其他数据目录，请替换为该服务的实际绝对路径。新密码只显示一次，交给对应使用者后即可登录。

查看账户或重置某个账户的密码：

```bash
pnpm account account list
pnpm account account reset-password traveler
```

重置密码会生成新的随机密码，并撤销该账户的全部登录会话。以上命令只在服务主机执行，普通使用者向服务管理员申请账户即可。

## 登录与模型

用创建的账户登录，按需要在隐私协议中同意 AI 与图片功能。在“设置 → 模型”填写供应商地址、模型名称和凭据，再选择可用模型。模型请求由所连服务处理，费用由相应供应商账户承担；源码不附带模型密钥或额度。

服务设置不会将浏览器、App 之间的本地笔记自动同步。数据位置、图片编辑和备份操作见[使用说明](../user-guide.md)。

## App

先确保服务可连接，再按 [App 说明](../mobile/README.md)安装依赖、设置精确的服务 URL、同步资源并构建。iOS 设备安装需要配置签名，Android 分发也需使用自己的发布签名。

## 随附资源

随附资源包含两份 MIT Skill、背景移除模型、底图与纹理及其许可证。完整行政区数据包需自行准备，来源与许可见[第三方资源](third-party.md)。
