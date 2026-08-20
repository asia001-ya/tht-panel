//! Claude 会话 JSONL 的用量解析。
//!
//! 每行形如：
//! ```json
//! {"type":"assistant","timestamp":"2026-08-05T20:56:03.324Z","requestId":"...",
//!  "message":{"id":"msg_011Cdj...","model":"claude-opus-5",
//!             "usage":{"input_tokens":2,"output_tokens":1,
//!                      "cache_creation_input_tokens":7840,"cache_read_input_tokens":5116,
//!                      "cache_creation":{"ephemeral_5m_input_tokens":7840,...}}}}
//! ```
//!
//! **去重是本模块的核心约束**：同一次 API 调用会写出多行（流式过程中的多次快照），
//! 它们共享同一 `message.id` 且 usage 内容相同。不去重会使统计翻数倍。
//! 实测本机单个会话文件中，45 处 usage 命中里存在大量同 id 重复行。

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::Value;

use super::{ParsedFile, UsageBucket};
use crate::usage::model::UsageTotals;

/// 解析单个 Claude 会话 JSONL 文件的用量。
///
/// 参数：`path`——jsonl 文件路径。
/// 返回：该文件的归属 slug 与用量桶；文件无法打开时返回 None。
/// 注意：与 history::claude 的轻解析不同，此处必须**全文件扫描**，
/// 不能套用 MAX_SCAN_LINES 之类的上限，否则用量会少算。
pub(crate) fn parse_file(path: &Path) -> Option<ParsedFile> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    // 归属键：projects/<slug>/... 中的 slug 段。subagents 位于 <slug>/<uuid>/subagents/，
    // 逐级上溯到 projects 的下一级即为 slug。
    let owner_key = owner_slug(path).unwrap_or_default();

    let mut seen_ids: HashSet<String> = HashSet::new();
    // (日期, 模型) → 累计用量。
    let mut buckets: std::collections::HashMap<(String, String), UsageTotals> =
        std::collections::HashMap::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // 非法 UTF-8 等，停止扫描该文件。
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue, // 跳过损坏行。
        };

        let message = match value.get("message") {
            Some(m) => m,
            None => continue,
        };
        let usage = match message.get("usage") {
            Some(u) => u,
            None => continue,
        };

        // 去重：无 id 的行无法判重，保守跳过（宁可少算也不重复计费）。
        let msg_id = match message.get("id").and_then(|v| v.as_str()) {
            Some(id) if !id.is_empty() => id,
            _ => continue,
        };
        if !seen_ids.insert(msg_id.to_string()) {
            continue;
        }

        let totals = UsageTotals {
            input_tokens: field(usage, "input_tokens"),
            output_tokens: field(usage, "output_tokens"),
            cache_read_tokens: field(usage, "cache_read_input_tokens"),
            cache_creation_tokens: field(usage, "cache_creation_input_tokens"),
        };
        if totals.is_zero() {
            continue;
        }

        let date = value
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(local_date)
            .unwrap_or_default();
        let model = message
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        buckets.entry((date, model)).or_default().add(&totals);
    }

    Some(ParsedFile {
        owner_key,
        buckets: buckets
            .into_iter()
            .map(|((date, model), totals)| UsageBucket {
                date,
                model,
                totals,
            })
            .collect(),
    })
}

/// 从 jsonl 路径中提取 `~/.claude/projects/<slug>` 的 slug 段。
///
/// 兼容两种深度：`projects/<slug>/x.jsonl` 与 `projects/<slug>/<uuid>/subagents/x.jsonl`。
/// 参数：`path`——jsonl 文件路径；返回：slug 目录名；结构不符时 None。
fn owner_slug(path: &Path) -> Option<String> {
    let mut current = path.parent()?;
    // 逐级上溯，直到父目录名为 projects，此时 current 即 slug 目录。
    loop {
        let parent = current.parent()?;
        if parent.file_name().and_then(|n| n.to_str()) == Some("projects") {
            return current.file_name().map(|n| n.to_string_lossy().to_string());
        }
        current = parent;
    }
}

/// 读取 usage 中的一个 u64 字段。
/// 参数：`usage`——usage 对象；`key`——字段名；返回：字段值，缺失或类型不符时 0。
fn field(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// 把 RFC3339 时间戳转成本地时区的 YYYY-MM-DD。
///
/// 用本地日期而非 UTC，保证「今天用了多少」与用户的墙上时间一致。
/// 参数：`ts`——RFC3339 字符串；返回：本地日期；解析失败时 None。
pub(crate) fn local_date(ts: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| {
            dt.with_timezone(&chrono::Local)
                .date_naive()
                .format("%Y-%m-%d")
                .to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    /// 测试专用临时目录，离开作用域时删除自身创建的目录。
    struct TestDir(PathBuf);

    impl TestDir {
        /// 创建带随机标识的测试目录。
        /// 参数：无；返回：测试目录守卫。
        fn new() -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("tht-panel-usage-claude-{}", uuid::Uuid::new_v4())),
            )
        }
    }

    impl Drop for TestDir {
        /// 删除当前测试创建的唯一目录。
        /// 参数：无；返回：无。
        fn drop(&mut self) {
            if self.0.exists() {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    /// 在 `projects/<slug>/` 结构下写出 jsonl，使 owner_slug 可解析。
    /// 参数：`dir`——测试目录守卫；`name`——文件名；`lines`——各行内容。
    /// 返回：jsonl 文件路径。
    fn write_jsonl(dir: &TestDir, name: &str, lines: &[&str]) -> PathBuf {
        let slug_dir = dir.0.join("projects").join("D--workspace-demo");
        std::fs::create_dir_all(&slug_dir).expect("创建 slug 目录");
        let path = slug_dir.join(name);
        let mut file = std::fs::File::create(&path).expect("创建 jsonl");
        for line in lines {
            writeln!(file, "{line}").expect("写入行");
        }
        path
    }

    /// 同一 message.id 的多行只能计一次，否则用量翻倍。
    #[test]
    fn same_message_id_counted_once() {
        let dir = TestDir::new();
        let line = r#"{"type":"assistant","timestamp":"2026-08-05T20:56:03.324Z","message":{"id":"msg_dup","model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":7}}}"#;
        // 同一行重复三次，模拟流式过程写出的多次快照。
        let path = write_jsonl(&dir, "dup.jsonl", &[line, line, line]);

        let parsed = parse_file(&path).expect("解析成功");
        assert_eq!(parsed.buckets.len(), 1, "应只有一个 (日期,模型) 桶");
        let totals = parsed.buckets[0].totals;
        assert_eq!(totals.input_tokens, 100, "重复行不得累加");
        assert_eq!(totals.output_tokens, 20);
        assert_eq!(totals.cache_read_tokens, 5);
        assert_eq!(totals.cache_creation_tokens, 7);
    }

    /// 不同 message.id 正常累加，且按模型分桶。
    #[test]
    fn distinct_ids_accumulate_per_model() {
        let dir = TestDir::new();
        let path = write_jsonl(
            &dir,
            "multi.jsonl",
            &[
                r#"{"timestamp":"2026-08-05T10:00:00.000Z","message":{"id":"a","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":1}}}"#,
                r#"{"timestamp":"2026-08-05T11:00:00.000Z","message":{"id":"b","model":"claude-opus-5","usage":{"input_tokens":30,"output_tokens":2}}}"#,
                r#"{"timestamp":"2026-08-05T12:00:00.000Z","message":{"id":"c","model":"claude-haiku-4-5","usage":{"input_tokens":7,"output_tokens":3}}}"#,
            ],
        );

        let parsed = parse_file(&path).expect("解析成功");
        assert_eq!(parsed.buckets.len(), 2, "两个模型应分成两个桶");
        let opus = parsed
            .buckets
            .iter()
            .find(|b| b.model == "claude-opus-5")
            .expect("存在 opus 桶");
        assert_eq!(opus.totals.input_tokens, 40, "同模型不同 id 应累加");
        assert_eq!(parsed.owner_key, "D--workspace-demo", "归属 slug 解析正确");
    }

    /// 损坏行与无 usage 行不得中断整体解析。
    #[test]
    fn malformed_lines_are_skipped() {
        let dir = TestDir::new();
        let path = write_jsonl(
            &dir,
            "broken.jsonl",
            &[
                "{ 这不是合法 JSON",
                r#"{"type":"user","message":{"content":"hi"}}"#,
                r#"{"timestamp":"2026-08-05T10:00:00.000Z","message":{"id":"ok","model":"m","usage":{"input_tokens":5,"output_tokens":1}}}"#,
            ],
        );

        let parsed = parse_file(&path).expect("解析成功");
        assert_eq!(parsed.buckets.len(), 1);
        assert_eq!(parsed.buckets[0].totals.input_tokens, 5);
    }

    /// 无 message.id 的用量行保守跳过（无法判重，宁可少算不重复计）。
    #[test]
    fn usage_without_id_is_skipped() {
        let dir = TestDir::new();
        let path = write_jsonl(
            &dir,
            "no-id.jsonl",
            &[
                r#"{"timestamp":"2026-08-05T10:00:00.000Z","message":{"model":"m","usage":{"input_tokens":999,"output_tokens":9}}}"#,
            ],
        );

        let parsed = parse_file(&path).expect("解析成功");
        assert!(parsed.buckets.is_empty(), "无 id 行不得计入");
    }
}
