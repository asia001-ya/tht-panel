//! Codex 会话 JSONL 的用量解析。
//!
//! 每行形如：
//! ```json
//! {"timestamp":"2026-08-02T23:54:41.516Z","type":"event_msg",
//!  "payload":{"type":"token_count",
//!             "info":{"total_token_usage":{...},"last_token_usage":{...}}}}
//! ```
//!
//! **关键差异**（实测确认，与 Claude 完全不同的结构）：
//! - `total_token_usage` 是会话开始至今的**累计快照**（逐事件递增），累加它会得出天文数字
//! - `last_token_usage` 是本次调用的**增量**，直接累加即可，无需去重（本身即增量）
//! - 字段名不同：`cached_input_tokens` 而非 `cache_read_input_tokens`，
//!   `cache_write_input_tokens` 保持，`reasoning_output_tokens` 并入 `output_tokens`
//! - 模型名不在该事件内，在 `type=turn_context` 的 `payload.model`，需维护「当前 turn 模型」状态

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::Value;

use super::{ParsedFile, UsageBucket};
use crate::usage::model::UsageTotals;

/// 解析单个 Codex 会话 JSONL 文件的用量。
///
/// 参数：`path`——jsonl 文件路径。
/// 返回：该文件的归属 cwd 与用量桶；文件无法打开时返回 None。
pub(crate) fn parse_file(path: &Path) -> Option<ParsedFile> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    // 归属键：Codex 用会话的 cwd，在第一行 session_meta.payload.cwd。
    let mut owner_key = String::new();
    let mut current_model = String::new(); // turn_context 更新，token_count 引用。
    let mut buckets: std::collections::HashMap<(String, String), UsageTotals> =
        std::collections::HashMap::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // session_meta（首行）提取 cwd。
        if event_type == "session_meta" && owner_key.is_empty() {
            owner_key = value
                .get("payload")
                .and_then(|p| p.get("cwd"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            continue;
        }

        // turn_context 更新当前模型。
        if event_type == "turn_context" {
            if let Some(m) = value
                .get("payload")
                .and_then(|p| p.get("model"))
                .and_then(|m| m.as_str())
            {
                current_model = m.to_string();
            }
            continue;
        }

        // event_msg.payload.type=token_count 才是用量事件。
        if event_type == "event_msg" {
            let payload = match value.get("payload") {
                Some(p) => p,
                None => continue,
            };
            if payload
                .get("type")
                .and_then(|t| t.as_str())
                != Some("token_count")
            {
                continue;
            }

            let info = match payload.get("info") {
                Some(i) => i,
                None => continue,
            };

            // 只取 last_token_usage（增量），忽略 total_token_usage（累计快照）。
            let last = match info.get("last_token_usage") {
                Some(l) => l,
                None => continue,
            };

            // Codex 字段映射：cached_input_tokens → cache_read_tokens,
            //                cache_write_input_tokens → cache_creation_tokens,
            //                reasoning_output_tokens 并入 output_tokens。
            let totals = UsageTotals {
                input_tokens: field(last, "input_tokens"),
                output_tokens: field(last, "output_tokens") + field(last, "reasoning_output_tokens"),
                cache_read_tokens: field(last, "cached_input_tokens"),
                cache_creation_tokens: field(last, "cache_write_input_tokens"),
            };
            if totals.is_zero() {
                continue;
            }

            let date = value
                .get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(crate::usage::claude::local_date)
                .unwrap_or_default();

            buckets
                .entry((date, current_model.clone()))
                .or_default()
                .add(&totals);
        }
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

/// 读取 usage 中的一个 u64 字段。
/// 参数：`usage`——usage 对象；`key`——字段名；返回：字段值，缺失或类型不符时 0。
fn field(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
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
            let dir = std::env::temp_dir()
                .join(format!("tht-panel-usage-codex-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("创建临时目录");
            Self(dir)
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

    /// 写出 rollout jsonl 文件。
    /// 参数：`dir`——测试目录守卫；`lines`——各行内容。
    /// 返回：jsonl 文件路径。
    fn write_jsonl(dir: &TestDir, lines: &[&str]) -> PathBuf {
        let path = dir.0.join("rollout-test.jsonl");
        let mut file = std::fs::File::create(&path).expect("创建 jsonl");
        for line in lines {
            writeln!(file, "{line}").expect("写入行");
        }
        path
    }

    /// 只累加 last_token_usage，total 是快照不可累加。
    #[test]
    fn only_last_is_accumulated() {
        let dir = TestDir::new();
        let path = write_jsonl(&dir, &[
            r#"{"timestamp":"2026-08-05T10:00:00.000Z","type":"session_meta","payload":{"cwd":"D:\\workspace\\demo","session_id":"abc"}}"#,
            r#"{"timestamp":"2026-08-05T10:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
            r#"{"timestamp":"2026-08-05T10:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10},"last_token_usage":{"input_tokens":100,"output_tokens":10}}}}"#,
            r#"{"timestamp":"2026-08-05T10:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"output_tokens":20},"last_token_usage":{"input_tokens":100,"output_tokens":10}}}}"#,
        ]);

        let parsed = parse_file(&path).expect("解析成功");
        assert_eq!(parsed.owner_key, "D:\\workspace\\demo");
        assert_eq!(parsed.buckets.len(), 1);
        let totals = parsed.buckets[0].totals;
        // 两次 last 各 100+10，累加得 200+20；若错误地累加 total 会得 300+30。
        assert_eq!(totals.input_tokens, 200, "只累加 last，不累加 total");
        assert_eq!(totals.output_tokens, 20);
    }

    /// reasoning_output_tokens 并入 output_tokens。
    #[test]
    fn reasoning_merged_into_output() {
        let dir = TestDir::new();
        let path = write_jsonl(&dir, &[
            r#"{"timestamp":"2026-08-05T10:00:00.000Z","type":"session_meta","payload":{"cwd":"/home/user/proj"}}"#,
            r#"{"timestamp":"2026-08-05T10:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
            r#"{"timestamp":"2026-08-05T10:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"output_tokens":5,"reasoning_output_tokens":3}}}}"#,
        ]);

        let parsed = parse_file(&path).expect("解析成功");
        assert_eq!(parsed.buckets[0].totals.output_tokens, 8, "5+3=8");
    }

    /// 模型从 turn_context 继承，切换模型后分入不同桶。
    #[test]
    fn model_from_turn_context() {
        let dir = TestDir::new();
        let path = write_jsonl(&dir, &[
            r#"{"timestamp":"2026-08-05T10:00:00.000Z","type":"session_meta","payload":{"cwd":"C:\\proj"}}"#,
            r#"{"timestamp":"2026-08-05T10:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#,
            r#"{"timestamp":"2026-08-05T10:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":1}}}}"#,
            r#"{"timestamp":"2026-08-05T10:00:03.000Z","type":"turn_context","payload":{"model":"gpt-7-preview"}}"#,
            r#"{"timestamp":"2026-08-05T10:00:04.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"output_tokens":2}}}}"#,
        ]);

        let parsed = parse_file(&path).expect("解析成功");
        assert_eq!(parsed.buckets.len(), 2, "两个模型分两个桶");
        let gpt56 = parsed
            .buckets
            .iter()
            .find(|b| b.model == "gpt-5.6-sol")
            .expect("gpt-5.6-sol");
        assert_eq!(gpt56.totals.input_tokens, 10);
        let gpt7 = parsed
            .buckets
            .iter()
            .find(|b| b.model == "gpt-7-preview")
            .expect("gpt-7-preview");
        assert_eq!(gpt7.totals.input_tokens, 20);
    }

    /// cached_input_tokens 映射到 cache_read_tokens（Codex 字段名与 Claude 不同）。
    #[test]
    fn codex_field_names_are_mapped() {
        let dir = TestDir::new();
        let path = write_jsonl(&dir, &[
            r#"{"timestamp":"2026-08-05T10:00:00.000Z","type":"session_meta","payload":{"cwd":"/p"}}"#,
            r#"{"timestamp":"2026-08-05T10:00:02.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":7,"output_tokens":5}}}}"#,
        ]);

        let parsed = parse_file(&path).expect("解析成功");
        let totals = parsed.buckets[0].totals;
        assert_eq!(totals.cache_read_tokens, 40, "cached_input_tokens → cache_read");
        assert_eq!(totals.cache_creation_tokens, 7, "cache_write → cache_creation");
        // Codex 的 input 已含 cached，此处不做减法，保持原值交前端按 driver 分支处理。
        assert_eq!(totals.input_tokens, 100);
    }
}
