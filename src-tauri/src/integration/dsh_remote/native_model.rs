//! Wire projections from upstream HarnessAlphaClient/remote-session-tools, 11064af.
use super::{
    gateway::{integer, string},
    RemoteError, Result,
};
use crate::features::remote_agent::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) const BACKEND: &str = "harness";
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceRow {
    pub workspace_id: String,
    pub title: String,
    pub session_ids: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRow {
    pub session_id: String,
    pub running: bool,
    pub title: Option<String>,
    pub parent_session_id: Option<String>,
    pub origin: Option<String>,
    #[serde(default)]
    pub projections: Value,
}
pub(crate) fn workspaces(baseline: &Value) -> Result<Vec<WorkspaceRow>> {
    if baseline.get("type").and_then(Value::as_str) != Some("baseline") {
        return Err(RemoteError::invalid("Invalid native workspace baseline"));
    }
    let rows: Vec<WorkspaceRow> = serde_json::from_value(
        baseline
            .pointer("/value/items")
            .cloned()
            .ok_or_else(|| RemoteError::invalid("Missing native workspace catalog"))?,
    )
    .map_err(|_| RemoteError::invalid("Invalid native workspace catalog"))?;
    if rows.len() > 4096 {
        return Err(RemoteError::invalid(
            "Native workspace catalog exceeds limit",
        ));
    }
    let mut ids = HashSet::new();
    for row in &rows {
        if row.workspace_id.is_empty() || !ids.insert(&row.workspace_id) {
            return Err(RemoteError::invalid(
                "Duplicate or empty native workspace ID",
            ));
        }
    }
    Ok(rows)
}
pub(crate) fn sessions(value: Value, workspace: &WorkspaceRow) -> Result<Vec<SessionRow>> {
    let rows: Vec<SessionRow> = serde_json::from_value(
        value
            .get("items")
            .cloned()
            .ok_or_else(|| RemoteError::invalid("Missing native session catalog"))?,
    )
    .map_err(|_| RemoteError::invalid("Invalid native session catalog"))?;
    let allowed: HashSet<_> = workspace.session_ids.iter().collect();
    let mut ids = HashSet::new();
    let mut result = Vec::new();
    for row in rows {
        if row.session_id.is_empty() || !ids.insert(row.session_id.clone()) {
            return Err(RemoteError::invalid("Duplicate or empty native session ID"));
        }
        if allowed.contains(&row.session_id)
            && row.parent_session_id.is_none()
            && row.origin.as_deref() != Some("subagent")
        {
            result.push(row);
        }
    }
    Ok(result)
}
pub(crate) fn ensure_backend(workspace: &WorkspaceRef) -> Result<()> {
    if workspace.backend_id.0 != BACKEND {
        return Err(RemoteError::new(
            "FEATURE_NOT_SUPPORTED",
            "Only native Harness sessions are mapped by this adapter",
        ));
    }
    Ok(())
}
pub(crate) fn address(session: &SessionRef) -> Value {
    json!({"kind":"session","sessionId":session.session_id.0})
}
pub(crate) fn source_stream(session: &SessionRef) -> String {
    format!(
        "harness:{}",
        json!([
            session.workspace.host.connection.provider_id.0,
            session.workspace.host.connection.connection_id.0,
            session.workspace.host.host_id.0,
            session.workspace.workspace_id.0,
            session.session_id.0
        ])
    )
}
pub(crate) fn cursor(session: &SessionRef, seq: i64) -> EventCursor {
    EventCursor {
        stream_id: source_stream(session),
        value: seq.to_string(),
    }
}
pub(crate) fn parse_cursor(session: &SessionRef, cursor: &EventCursor) -> Result<i64> {
    if cursor.stream_id != source_stream(session) {
        return Err(RemoteError::invalid(
            "Native cursor belongs to a different session",
        ));
    }
    let seq: i64 = cursor
        .value
        .parse()
        .map_err(|_| RemoteError::invalid("Invalid native history cursor"))?;
    if seq < -1 || seq > super::protocol::MAX_SAFE_INTEGER as i64 || seq.to_string() != cursor.value
    {
        return Err(RemoteError::invalid("Invalid native history cursor"));
    }
    Ok(seq)
}
pub(crate) fn through(value: &Value) -> Result<i64> {
    value
        .get("cursor")
        .and_then(Value::as_i64)
        .filter(|s| *s >= -1 && *s <= super::protocol::MAX_SAFE_INTEGER as i64)
        .ok_or_else(|| RemoteError::invalid("Invalid native snapshot cursor"))
}
pub(crate) fn records(page: &Value, through: i64) -> Result<Vec<Value>> {
    if page.get("hasMore").and_then(Value::as_bool).is_none() {
        return Err(RemoteError::invalid(
            "Missing native history pagination state",
        ));
    }
    let rows = page
        .get("records")
        .and_then(Value::as_array)
        .ok_or_else(|| RemoteError::invalid("Missing native history records"))?;
    let mut previous = None;
    for row in rows {
        if !matches!(
            row.get("type").and_then(Value::as_str),
            Some("event" | "chunks")
        ) {
            return Err(RemoteError::invalid("Invalid native history record type"));
        }
        let event = row
            .get("event")
            .ok_or_else(|| RemoteError::invalid("Missing native event"))?;
        let seq = integer(event, "seq")?;
        string(event, "type")?;
        if seq as i64 > through || previous.is_some_and(|before| seq <= before) {
            return Err(RemoteError::invalid(
                "Invalid or nonmonotonic native event sequence",
            ));
        }
        previous = Some(seq);
    }
    Ok(rows.clone())
}
pub(crate) fn event(session: &SessionRef, native: &Value) -> Result<Option<RemoteEvent>> {
    let seq = integer(native, "seq")?;
    let kind = string(native, "type")?;
    let data = native.get("data").unwrap_or(&Value::Null);
    let payload = match kind {
        "user/message" | "assistant/message" => {
            let content = data
                .pointer("/message/content")
                .or_else(|| data.get("content"))
                .and_then(Value::as_array)
                .ok_or_else(|| RemoteError::invalid("Missing native message content"))?;
            let text = content
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .ok_or_else(|| RemoteError::invalid("Invalid native text content"))
                })
                .collect::<Result<Vec<_>>>()?
                .join("\n");
            EventPayload::Message {
                role: if kind == "user/message" {
                    "user"
                } else {
                    "assistant"
                }
                .into(),
                text,
            }
        }
        "turn/start" => EventPayload::TaskStatus {
            status: TaskStatus::Running,
        },
        "turn/end" => EventPayload::TaskStatus {
            status: match data
                .get("reason")
                .and_then(Value::as_str)
                .or_else(|| data.pointer("/reason/kind").and_then(Value::as_str))
            {
                Some("error" | "failed") => TaskStatus::Failed,
                Some("cancelled" | "canceled") => TaskStatus::Cancelled,
                _ => TaskStatus::Idle,
            },
        },
        // Chunk, tool, and replacement surfaces have no faithful equivalent in
        // the shared text-event contract. Final native messages remain intact.
        _ => return Ok(None),
    };
    Ok(Some(RemoteEvent {
        session: session.clone(),
        source_stream_id: source_stream(session),
        source_id: format!("seq:{seq}"),
        cursor: Some(cursor(session, seq as i64)),
        payload,
    }))
}
pub(crate) fn status(
    row: &SessionRow,
    records: &[Value],
    projection: Option<&Value>,
) -> Result<TaskStatus> {
    let mut status = if row.running {
        TaskStatus::Running
    } else {
        TaskStatus::Idle
    };
    for record in records {
        let native = &record["event"];
        match string(native, "type")? {
            "turn/start" => status = TaskStatus::Running,
            "turn/end" => {
                status = match native
                    .pointer("/data/reason")
                    .and_then(Value::as_str)
                    .or_else(|| native.pointer("/data/reason/kind").and_then(Value::as_str))
                {
                    Some("error" | "failed") => TaskStatus::Failed,
                    Some("cancelled" | "canceled") => TaskStatus::Cancelled,
                    _ => TaskStatus::Idle,
                }
            }
            _ => {}
        }
    }
    let values = projection
        .and_then(|p| p.get("values"))
        .or_else(|| row.projections.get("values"));
    if values
        .and_then(|v| v.pointer("/inbox/next-turn"))
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
    {
        status = TaskStatus::Running;
    }
    Ok(status)
}
pub(crate) fn questions(value: &Value) -> Result<Vec<Question>> {
    let rows = value
        .as_array()
        .filter(|v| v.len() <= 64)
        .ok_or_else(|| RemoteError::invalid("Invalid native questions"))?;
    let mut ids = HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let id = string(row, "id")?.to_owned();
        if !ids.insert(id.clone()) {
            return Err(RemoteError::invalid("Duplicate native question ID"));
        }
        let options = row
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .map(|option| string(option, "label").map(str::to_owned))
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default();
        out.push(Question {
            id,
            prompt: string(row, "question")?.to_owned(),
            options,
            multiple: row
                .get("multiSelect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            allows_custom: true,
        });
    }
    Ok(out)
}
