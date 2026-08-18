# DeepSeek Harness 桌面版

> 开源地址：<https://github.com/qinlinglong/deepseek-harness-desktop>

基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的跨平台桌面应用（Electron），**免命令行安装**。打包时已将 Node.js 运行时、`@deepseek-ai/dsh` 及全部依赖内置，双击即用，无需安装 Node.js、无需执行任何命令。

## 功能亮点

### 三种连接方式

> 在设置页或悬浮球右键菜单即可随时切换，保存后立即生效。

**本机模式（默认）**：开箱即用，应用内置完整的 Agent Harness 服务，双击即可开始使用。

<div align="center">
  <img src="assets/dsh-pic-本地模式-即可启动直接打开使用.jpg" width="560" />
</div>

**局域网服务端**：把本机 Agent 能力安全地分享给整个局域网。开启后自动探测并给出「IP + 端口」访问地址；端口被占用时自动顺延到空闲端口，并自动过滤不可达的网卡 IP。

<div align="center">
  <img src="assets/dsh-pic-开启局域网访问.jpg" width="560" />
</div>

局域网内任意设备用浏览器打开上方地址，首次访问会进入登录认证界面，输入访问密码即可使用：

<div align="center">
  <img src="assets/dsh-pic-局域网服务登录认证界面.jpg" width="320" />
  <img src="assets/dsh-pic-开启局域网访问-打开网站.jpg" width="320" />
</div>

**局域网连接**：连接 `127.0.0.1` 本机服务，或局域网内其他设备开启的局域网服务端。选择该模式会自动跳转到填写页面，填入 IP + 端口 + 协议（HTTP/HTTPS）即可连上远程服务。

<div align="center">
  <img src="assets/dsh-pic-远程链接.jpg" width="560" />
</div>

### 桌面悬浮球与迷你聊天窗口

> 常驻桌角的白色圆形悬浮球 + 聚焦聊天的轻量迷你窗，配合使用，随时呼出随时收起。

**桌面悬浮球**：始终置顶，是最高效的入口。

- **点击**：弹出迷你聊天窗口，随时对话
- **按住拖动**：任意摆放位置（防误触设计，按住约 0.2 秒后进入拖动）
- **右键菜单**：快速切换应用图标、三种连接方式、打开设置或退出，无需进入主界面
- 全屏/其他应用之上依然可见，随叫随到

**迷你聊天窗口**：自动隐藏侧边栏与详情栏，只保留对话输入区，让注意力不被干扰。

- 顶部工具栏：打开主窗口 / 置顶切换 / 收起
- 始终置顶可选，配合悬浮球使用，随时呼出随时收起

<div align="center">
  <img src="assets/dsh-pic-悬浮图标和迷你窗口.jpg" width="560" />
</div>

### 应用图标切换

> 设置中可在「DeepSeek（默认）/ D娘」间切换，托盘、窗口、Dock 与悬浮球图标即时生效。

## 下载与安装

从 [GitHub Releases](https://github.com/qinlinglong/deepseek-harness-desktop/releases) 下载对应平台产物：

| 平台 | 安装包 |
|------|--------|
| macOS | `DeepSeek-Harness-<版本>-arm64.dmg`（或 `-mac.zip`） |
| Windows | `DeepSeek-Harness-Setup-<版本>.exe`（安装版）或 `DeepSeek-Harness-<版本>-portable.exe`（免安装版） |
| Linux | `DeepSeek-Harness-<版本>.AppImage` 或 `dsh-desktop_<版本>_amd64.deb` |

> **macOS 首次打开提示「已损坏，无法打开」/「无法验证开发者」**：应用暂未进行 Apple 签名与公证，非 App Store 下载的未签名应用会被 Gatekeeper 拦截。任选其一放行：
> - 右键应用 → 打开 → 在二次确认弹窗中点击「打开」；
> - 或执行 `xattr -cr "/Applications/DeepSeek Harness.app"`（zip 版先解压，再对 `.app` 执行）；
> - 使用 Apple Developer ID 证书签名并公证后即可消除此提示。

## 平台注意事项

- **Windows**：安装包未签名，首次运行可能提示「Windows 已保护你的电脑」，选择「更多信息 → 仍要运行」即可。Agent 部分工具依赖 bash 环境，**建议安装 [Git for Windows](https://git-scm.com/download/win)（自带 Git Bash）**，否则部分工具（如终端/bash 命令）可能不可用。
- **Linux**：AppImage 需系统安装 FUSE（Debian/Ubuntu：`sudo apt install libfuse2`）；透明悬浮球在 Wayland 合成器下可能显示异常，建议在 X11 会话下使用。
- **托盘图标**：依赖系统托盘实现（Windows 任务栏 / Linux AppIndicator，GNOME 需安装 AppIndicator 扩展）。

## 安全模型

局域网访问由两层防护：

1. **密码门禁**：应用在 `0.0.0.0:<局域网端口>` 启动一个反向代理，未携带有效登录 Cookie 的请求一律返回登录页。密码以 scrypt KDF（随机盐 + 高计算成本）形式存储（config.json，格式 `scrypt$N$r$p$salt$hash`，旧版 sha256 哈希自动兼容并在下次登录时升级），登录比较使用恒定时间算法（`crypto.timingSafeEqual`）。
2. **dsh 浏览器信任围栏**：dsh 本身绑定 `127.0.0.1`（随机端口），并通过 `--trusted-host <局域网IP>` 只信任当前机器的局域网 IP。因此即便知道密码，DNS 重绑定、跨站请求、以及通过其它 IP 的访问都会被 dsh 的 `/api` 围栏拒绝（403）。

> ⚠ 局域网模式下，任何知道密码的设备都能操作本机 Agent 并执行命令。请设置高强度密码，仅在可信网络使用。

## 数据与配置

- 用户数据：`~/.dsh`（dsh 的 harness home，含 profiles / 会话 / 凭据）
- 应用配置：`<userData>/config.json`（连接方式、局域网端口、密码哈希）
- 配置目录：
  - macOS: `~/Library/Application Support/dsh-desktop/`
  - Windows: `%APPDATA%/dsh-desktop/`
  - Linux: `~/.config/dsh-desktop/`

## 开发

```bash
npm install
npm start            # 开发模式启动
```

> ⚠ 维护提示：`@deepseek-ai/*` 的 **peerDependencies** 不会被 electron-builder 自动打包，
> 必须显式声明在根 `package.json` 的 `dependencies` 中（见 `cordis-plugin-group`、`dsh-fs`、
> `dsh-shell`、`dsh-subprocess` 等）。升级 `@deepseek-ai/dsh` 后若打包版启动报
> `ERR_MODULE_NOT_FOUND`，对照 dev 环境补齐缺失的 peer 依赖即可。

## 打包

| 平台 | 命令 | 产物 |
|------|------|------|
| macOS | `npm run dist:mac` | `release/*.dmg`、`*.zip`、`.app` |
| Windows | `npm run dist:win` | `release/*.exe`（NSIS 安装包 + portable 免安装版） |
| Linux | `npm run dist:linux` | `release/*.AppImage`、`*.deb` |

- **必须在目标平台上构建**：Windows / Linux 产物必须分别在 Windows / Linux（或 CI）上执行 `npm ci` 后构建。原因是 sharp、koffi、node-addon-require-builtin、landlock 等原生模块以 `optionalDependencies` 按平台安装——在 macOS 上 cross-build 只会打包 darwin 原生二进制，生成的 Windows/Linux 安装包会在启动时因缺少 `*_win32-x64` / `*_linux-x64` 模块而直接崩溃。
- 推荐使用仓库内置的 GitHub Actions 工作流（`.github/workflows/build.yml`）：三平台矩阵各自在对应 OS 上 `npm ci` + 构建，构建后自动运行 `node scripts/verify-native.mjs` 校验原生模块齐全，再上传产物。
- 本地可先跑 `node scripts/verify-native.mjs` 快速检查 `release/*-unpacked` 中当前平台的原生模块是否齐全。
- 应用内已内置 Node 运行时（Electron 的 `ELECTRON_RUN_AS_NODE`），原生模块（node-pty、sharp、koffi 等）均为 N-API prebuild，跨平台可用（前提是按上面要求在各平台安装）。
- 如需签名/公证，在 electron-builder 配置中补充证书环境变量即可；未签名构建可直接内部分发使用。

### 自动发布

打 `v*` tag 推送到 GitHub 即触发三平台 CI 构建，并自动创建 GitHub Release（草稿）上传三平台安装包；在 Release 页面确认后发布即可公开下载。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## 目录结构

```
main.js               Electron 主进程：服务编排、局域网反代、鉴权、悬浮球/迷你窗
preload.js            渲染进程桥接
renderer/index.html   启动页 + 连接设置界面
renderer/floating.*   桌面悬浮球
renderer/mini.*       迷你聊天窗口（webview + 顶部按钮栏）
assets/icons/         应用图标（DeepSeek（默认）/ D娘）
assets/               界面截图（README 配图）
build/                打包用图标
scripts/gen-icon.mjs  图标生成脚本
scripts/verify-native.mjs  校验打包产物原生模块齐全（CI 使用）
.github/workflows/build.yml  三平台矩阵构建工作流
```

## 协议

MIT。DeepSeek Harness 由 DeepSeek AI 开发，本仓库仅为打包封装。
