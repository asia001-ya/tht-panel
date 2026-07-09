//! 应用入口装配（lib.rs）。
//!
//! 组装 Tauri Builder：
//! - 插件：single-instance（防多开，第二实例唤起已有窗口）、dialog、notification；
//! - 全局状态：AppState::new（ConfigStore + PtyManager）；
//! - 命令：generate_handler! 注册全部命令；
//! - setup：创建系统托盘；
//! - on_window_event：拦截窗口关闭为 hide（进托盘保活，风险 10）。

pub mod commands;
pub mod config;
pub mod error;
pub mod history;
pub mod pty;
pub mod state;
pub mod tray;

use tauri::{Manager, WindowEvent};

use crate::state::AppState;

/// 应用运行入口：装配并启动 Tauri。
/// 参数：无；返回：无（阻塞直至应用退出）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 必须最先注册：第二个实例启动时唤起已运行的主窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            crate::tray::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 初始化全局状态（加载配置 + 创建 PtyManager），失败则中止启动。
            let app_state = AppState::new(app.handle())?;
            app.manage(app_state);
            // 创建系统托盘。
            crate::tray::setup_tray(app.handle())?;
            Ok(())
        })
        // 窗口关闭拦截：阻止真正关闭，改为隐藏到托盘（会话继续保活）。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_cmds::pty_spawn,
            commands::pty_cmds::pty_write,
            commands::pty_cmds::pty_resize,
            commands::pty_cmds::pty_kill,
            commands::pty_cmds::pty_list,
            commands::pty_cmds::pty_attach,
            commands::pty_cmds::pty_detach,
            commands::config_cmds::config_get,
            commands::config_cmds::config_set,
            commands::config_cmds::workspace_list,
            commands::config_cmds::workspace_save,
            commands::config_cmds::workspace_delete,
            commands::config_cmds::layout_get,
            commands::config_cmds::layout_save,
            commands::history_cmds::history_list,
            commands::app_quit,
            commands::session_cmds::managed_session_list,
            commands::session_cmds::managed_session_create,
            commands::session_cmds::managed_session_update,
            commands::session_cmds::managed_session_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
