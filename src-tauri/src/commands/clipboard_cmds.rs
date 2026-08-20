//! 剪贴板增强命令：把前端读取到的图片安全地落到临时目录，返回可粘贴路径。

use base64::Engine;

use crate::error::AppError;

/// 将 data:image/...;base64,... 写入当前用户临时目录。
///
/// 前端优先通过 ClipboardEvent 读取图片；这里不直接访问系统剪贴板，
/// 因而不需要额外的平台剪贴板依赖，也能在浏览器预览模式中自然降级。
#[tauri::command]
pub fn clipboard_save_image(
    data_url: String,
    file_name: Option<String>,
) -> Result<String, AppError> {
    const MAX_DATA_URL_BYTES: usize = 25 * 1024 * 1024;
    if data_url.len() > MAX_DATA_URL_BYTES {
        return Err(AppError::Other("剪贴板图片过大".to_string()));
    }

    let (header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| AppError::Other("无效的图片 data URL".to_string()))?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .unwrap_or_default();
    if !mime.starts_with("image/") || !header.contains(";base64") {
        return Err(AppError::Other("仅支持 base64 图片 data URL".to_string()));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| AppError::Other(format!("图片解码失败: {error}")))?;
    if bytes.is_empty() {
        return Err(AppError::Other("剪贴板图片为空".to_string()));
    }

    let extension = match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "bin",
    };

    let mut directory = std::env::temp_dir();
    directory.push("tht-panel");
    directory.push("clipboard");
    std::fs::create_dir_all(&directory)?;

    // 文件名只用于保留用户提供的 stem，路径和扩展名始终由后端生成。
    let stem = file_name
        .as_deref()
        .and_then(|name| std::path::Path::new(name).file_stem())
        .and_then(|name| name.to_str())
        .map(|name| {
            name.chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
                .collect::<String>()
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "clipboard-image".to_string());
    let path = directory.join(format!("{stem}-{}.{}", uuid::Uuid::new_v4(), extension));
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::clipboard_save_image;

    #[test]
    fn rejects_non_image_data_url() {
        assert!(clipboard_save_image("data:text/plain;base64,QQ==".to_string(), None).is_err());
    }
}
