# Repository Guidelines

## Project Structure & Module Organization

`src/` 是 React 19 + TypeScript 前端，按 `components/`、`terminal/`、`store/`、`api/` 和 `styles/` 分层。`src-tauri/src/` 是 Rust 后端；`commands/` 仅做命令转发，`config/`、`history/`、`pty/` 分别负责配置、AI 历史和终端生命周期。静态资源位于 `public/`、`src/assets/`，打包图标位于 `src-tauri/icons/`。不要手工修改 `dist/`、`node_modules/` 或 `src-tauri/target/`。

## Build, Test, and Development Commands

- `npm ci`：按 `package-lock.json` 安装前端依赖。
- `npm run tauri -- dev`：启动桌面开发环境；仅调试前端时使用 `npm run dev`（端口 `1420`）。
- `npm run typecheck`：执行严格 TypeScript 检查。
- `npm run build`：运行 `tsc` 并生成 Vite 产物。
- `cargo check --manifest-path src-tauri/Cargo.toml`：检查 Rust 后端。
- `npm run tauri -- build`：构建 Windows NSIS 安装包。

## Coding Style & Naming Conventions

TypeScript/TSX 沿用 2 空格缩进、双引号、分号和尾逗号，并保持 `strict`。组件与文件使用 `PascalCase`，Hook 使用 `useXxx`，Zustand store 使用 `useXxxStore`，常量使用 `UPPER_SNAKE_CASE`。Rust 使用 `rustfmt`，函数/模块用 `snake_case`，类型用 `PascalCase`；Tauri command 保持薄层并返回 `Result<_, AppError>`。新增注释使用简体中文，说明约束与原因。仓库未配置 ESLint 或 Prettier。

## Testing Guidelines

没有自动化测试框架或覆盖率门槛。提交前运行 `npm run typecheck`、`npm run build` 和上述 `cargo check`，并手工验证应用启动、PTY 新建/恢复、分屏及托盘。新增前端测试命名为 `*.test.ts(x)`；Rust 单元测试放在对应模块的 `#[cfg(test)]` 中。引入框架时同步新增 npm/Cargo 测试命令。

## Commit & Pull Request Guidelines

仓库历史仅有 3 条提交，近期倾向简短中文摘要，尚无正式 Conventional Commits 规范。使用中文主题，可写成 `fix(pty): 修复会话重连`。PR 默认以 `dev` 为基线，并说明目的、影响模块、验证命令和关联 Issue；界面变化附截图或 GIF。依赖变化同时提交锁文件，避免夹带生成文件。

## Security & Configuration Tips

不要提交密钥、令牌、本机路径、终端内容或会话历史；`.claude/` 与 `*.local` 已被忽略。本地 API key 会明文保存到应用配置，勿在共享机器使用生产凭据。修改 Tauri capabilities 或安全配置时遵循最小权限，并在 PR 中解释新增权限。
