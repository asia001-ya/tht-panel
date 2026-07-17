# tht-panel

多工作空间 AI 终端面板管理器。在一个窗口里统一管理多个 Claude / Codex CLI 会话，解决多窗口切换、供应商配置隔离和会话持久化的痛点。

会话进程由 Rust 后端统一持有——后端是唯一真相源，前端切换工作区或窗格只改变视图，不会中断正在运行的 CLI 进程。

> 平台：目前面向 Windows（依赖 ConPTY，打包产物为 NSIS 安装包）。

## 核心功能

- **多工作空间**：每个项目一个工作空间，绑定项目目录与默认 AI 类型；侧边栏可展开查看该项目的历史会话。
- **多类型会话**：每个工作空间可启动 Claude、Codex 或纯 Shell（PowerShell / pwsh / cmd）会话。
- **分屏布局**：二叉树式自由分屏（左右 / 上下），支持窗格锁定、拖拽交换、命名与比例调整。
- **会话持久化与恢复**：布局与会话引用落盘；重启后可点击已保存工作区恢复布局，存活的 PTY 原位复用，已退出的以 `--resume` 重建。
- **工作区自动保存**：工作区为"活文档"——新建即激活，此后布局、Tab、会话的任何变动自动写回。
- **多供应商隔离**：同一 AI 类型可保存多套命名供应商（各自的 URL / 密钥 / 模型），按会话或按项目选择，进程级隔离（Claude 用 `--settings`，Codex 用独立 `CODEX_HOME`）。
- **会话历史与 resume**：自动记录会话并探测其 AI session id，支持从历史一键恢复对话。
- **Keep-Alive**：可按工作空间配置定时指令，防止长时间空闲会话超时。
- **系统托盘与单实例**：关闭窗口隐藏到托盘、会话保活；第二次启动唤起已有窗口而非多开。
- **系统通知**：会话进入等待输入状态时发送 Windows 通知。
- **终端体验**：xterm.js 渲染，支持 WebGL 加速、主题切换、字号调整、搜索、Unicode 11 宽字符（中文 / emoji）修正。

## 技术栈

**前端**
- React 19 + TypeScript 5
- Vite 7（开发与打包）
- xterm.js 5.5（终端渲染，含 fit / search / webgl / unicode11 插件）
- zustand 5（状态管理）
- react-resizable-panels 2（分屏）
- lucide-react（图标）
- Vitest 4 + Testing Library（测试）

**后端**
- Tauri 2 + Rust（2021 edition）
- portable-pty（ConPTY 封装，持有全部 PTY 会话）
- serde / serde_json（配置序列化）
- parking_lot（Mutex）、thiserror（错误）、chrono（时间戳）、uuid（会话 ID）

## 架构

```
┌─────────────────────────────────────────────┐
│  前端 (React / xterm.js)                       │
│  侧边栏(工作空间/会话) │ 分屏区(PaneGrid) │ 对话框  │
│         ↕ Tauri invoke / event                │
├─────────────────────────────────────────────┤
│  后端 (Rust / Tauri)                           │
│  ConfigStore(配置读写) │ PtyManager(持有全部 PTY) │
└─────────────────────────────────────────────┘
```

关键设计：**后端持有真相**。所有 PTY 进程生命周期在 Rust 侧管理，前端只维护"哪个会话显示在哪个窗格"的视图状态。切换工作区、关闭窗格 Tab 都不会杀掉进程，除非显式关闭会话。

## 环境要求

- Node.js（含 npm）
- Rust 工具链（`rustup`）
- Windows 上需 MSVC C++ 生成工具（`Microsoft.VisualStudio.2022.BuildTools` 的 VCTools 工作负载）
- WebView2（Windows 11 已预装）

## 开发

```bash
# 安装前端依赖
npm install

# 启动开发（Vite + Tauri 桌面窗口）
npm run tauri dev

# 仅启动前端（浏览器，不含后端能力）
npm run dev
```

## 构建

```bash
# 打包桌面应用（产出 Windows NSIS 安装包）
npm run tauri build
```

## 测试与检查

```bash
npm test           # 前端单元测试 (Vitest)
npm run typecheck  # TypeScript 类型检查
npm run build      # 前端类型检查 + 打包

# 后端 (在 src-tauri 下 / 或用 --manifest-path)
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt  --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

## 目录结构

```
tht-panel/
├── src/                    # 前端源码
│   ├── components/         # 侧边栏、分屏、对话框、任务抽屉等组件
│   ├── store/              # zustand stores (layout / session / workspace / settings / task)
│   ├── terminal/           # xterm 封装与终端面板
│   ├── lib/                # 工作区快照/恢复、供应商解析等纯逻辑
│   └── api/                # Tauri 命令与事件绑定、类型定义
├── src-tauri/              # 后端源码 (Rust)
│   ├── src/
│   │   ├── pty/            # PTY 管理、spawn、会话、活动检测
│   │   ├── config/         # 配置存储与数据模型
│   │   ├── commands/       # Tauri 命令处理
│   │   └── collaboration/  # 窗格协作任务
│   └── tauri.conf.json
└── docs/                   # 设计与实施文档
```

## 数据存储

配置与会话数据以 JSON 保存在应用配置目录下（**不在仓库内**）：

```
%APPDATA%\com.tht.panel\
├── settings.json     # 全局设置 + 命名供应商 (含 API 密钥)
├── workspaces.json   # 工作空间列表
├── layout.json       # 分屏布局与已保存工作区
└── sessions.json     # 自管会话记录
