//! 系统托盘（tray.rs，对照计划 8.7 / 风险 10）。
//!
//! - 用 TrayIconBuilder 建托盘（复用窗口默认图标），菜单含「显示」「退出」；
//! - 左键点击托盘图标 → 显示主窗口；
//! - 「退出」：若存在活跃（未 dead）会话，显示窗口并 emit `app://quit-request`
//!   让前端弹确认；否则直接 kill_all + 退出；
//! - 窗口关闭拦截为 hide（进托盘保活）在 lib.rs 的 on_window_event 中处理。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::model::EVT_QUIT_REQUEST;
use crate::error::AppError;
use crate::state::AppState;

/// 构建系统托盘图标与菜单，并挂接事件处理。
/// 参数：app——AppHandle；返回：() 或 AppError。
pub fn setup_tray(app: &AppHandle) -> Result<(), AppError> {
    // 菜单项：显示 / 退出。
    let show_item = MenuItem::with_id(app, "show", "显示", true, None::<&str>)
        .map_err(|e| AppError::Other(format!("创建菜单项失败: {e}")))?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|e| AppError::Other(format!("创建菜单项失败: {e}")))?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])
        .map_err(|e| AppError::Other(format!("创建托盘菜单失败: {e}")))?;

    // 托盘图标复用窗口默认图标。
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| AppError::Other("无可用的默认窗口图标".to_string()))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("tht-panel")
        .menu(&menu)
        // 左键点击弹菜单会与"左键显示窗口"冲突，这里关闭左键弹菜单，仅右键弹。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => on_quit_clicked(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击（抬起）显示主窗口。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| AppError::Other(format!("创建托盘失败: {e}")))?;

    Ok(())
}

/// 显示并聚焦主窗口（从托盘恢复）。
/// 参数：app——AppHandle；返回：无。
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 处理托盘「退出」点击：有活跃会话则弹确认，否则直接清理退出。
/// 参数：app——AppHandle；返回：无。
fn on_quit_clicked(app: &AppHandle) {
    if crate::commands::has_active_sessions(app) {
        // 有未结束会话：显示窗口并请前端弹确认（避免误杀正在跑的 AI 任务）。
        show_main(app);
        let _ = app.emit(EVT_QUIT_REQUEST, ());
    } else {
        // 无活跃会话：直接 kill_all（清理可能残留的 dead 句柄）并退出。
        let state = app.state::<AppState>();
        state.pty.kill_all();
        app.exit(0);
    }
}
