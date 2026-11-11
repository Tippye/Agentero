//! Three-way merge of EmbedPDF `AnnotationTransferItem[]` sidecars.
//!
//! The complete transfer item (including stamp `ctx` and custom metadata) is
//! opaque payload. Only `annotation.id` supplies identity. No envelope or
//! tombstones are added: absence relative to the immutable base is a deletion.
//! Ambiguous same-ID changes require exact source conflict copies at the caller.

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub(crate) struct AnnotationMerge {
    pub bytes: Vec<u8>,
    pub conflicted: bool,
}

pub(crate) fn merge(
    base: Option<&[u8]>,
    local: &[u8],
    remote: &[u8],
) -> Result<AnnotationMerge, String> {
    let base = base.map(items).transpose()?.unwrap_or_default();
    let local = items(local)?;
    let remote = items(remote)?;
    let ids: BTreeSet<_> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect();
    let mut merged = Vec::new();
    let mut conflicted = false;
    for id in ids {
        let (b, l, r) = (base.get(id), local.get(id), remote.get(id));
        let winner = if l == r {
            l
        } else if l == b {
            r
        } else if r == b {
            l
        } else {
            conflicted = true;
            match (l, r) {
                // Concurrent edit/delete: deletion wins the canonical array;
                // the edited bytes remain recoverable in a conflict copy.
                (None, _) | (_, None) => None,
                // Value has no general ordering. Compare canonical JSON bytes
                // (parse_json sorted object keys), independent of device, mtime,
                // or sync direction; the caller retains the losing payload.
                (Some(l), Some(r)) => {
                    let local_payload = serde_json::to_vec(l).map_err(|e| e.to_string())?;
                    let remote_payload = serde_json::to_vec(r).map_err(|e| e.to_string())?;
                    Some(if local_payload >= remote_payload {
                        l
                    } else {
                        r
                    })
                }
            }
        };
        if let Some(item) = winner {
            merged.push(item.clone());
        }
    }
    let mut bytes = serde_json::to_vec_pretty(&merged).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(AnnotationMerge { bytes, conflicted })
}

fn items(bytes: &[u8]) -> Result<BTreeMap<String, Value>, String> {
    let value = parse_json(bytes).map_err(|e| e.to_string())?;
    let array = value
        .as_array()
        .ok_or("expected annotation transfer array")?;
    let mut items = BTreeMap::new();
    for item in array {
        let annotation = item
            .as_object()
            .and_then(|item| item.get("annotation"))
            .and_then(Value::as_object)
            .ok_or("expected annotation transfer item")?;
        let id = annotation
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or("annotation has no identity")?;
        // Recognize the installed EmbedPDF base format without projecting or
        // dropping any other fields, annotation subtypes, or transfer context.
        if annotation.get("type").and_then(Value::as_u64).is_none()
            || annotation
                .get("pageIndex")
                .and_then(Value::as_u64)
                .is_none()
            || !valid_rect(annotation.get("rect"))
        {
            return Err("unrecognized annotation format".into());
        }
        if items.insert(id.to_string(), item.clone()).is_some() {
            return Err("duplicate annotation identity".into());
        }
    }
    Ok(items)
}

fn valid_rect(rect: Option<&Value>) -> bool {
    let Some(rect) = rect else { return false };
    ["/origin/x", "/origin/y", "/size/width", "/size/height"]
        .iter()
        .all(|path| {
            rect.pointer(path)
                .and_then(Value::as_f64)
                .is_some_and(f64::is_finite)
        })
}

/// Refuse duplicate JSON object keys rather than let Value's normal parser
/// silently overwrite one. Sorted keys also make payload ties deterministic
/// even when another workspace dependency enables serde_json/preserve_order.
pub(crate) fn parse_json(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    #[derive(Debug)]
    struct Unique(Value);
    impl<'de> Deserialize<'de> for Unique {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct JsonVisitor;
            impl<'de> Visitor<'de> for JsonVisitor {
                type Value = Unique;
                fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str("JSON with unique object keys")
                }
                fn visit_bool<E: de::Error>(self, v: bool) -> Result<Unique, E> {
                    Ok(Unique(Value::Bool(v)))
                }
                fn visit_i64<E: de::Error>(self, v: i64) -> Result<Unique, E> {
                    Ok(Unique(Value::from(v)))
                }
                fn visit_u64<E: de::Error>(self, v: u64) -> Result<Unique, E> {
                    Ok(Unique(Value::from(v)))
                }
                fn visit_f64<E: de::Error>(self, v: f64) -> Result<Unique, E> {
                    serde_json::Number::from_f64(v)
                        .map(|v| Unique(Value::Number(v)))
                        .ok_or_else(|| E::custom("nonfinite number"))
                }
                fn visit_str<E: de::Error>(self, v: &str) -> Result<Unique, E> {
                    Ok(Unique(Value::String(v.into())))
                }
                fn visit_string<E: de::Error>(self, v: String) -> Result<Unique, E> {
                    Ok(Unique(Value::String(v)))
                }
                fn visit_unit<E: de::Error>(self) -> Result<Unique, E> {
                    Ok(Unique(Value::Null))
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Unique, A::Error> {
                    let mut values = Vec::new();
                    while let Some(Unique(value)) = seq.next_element()? {
                        values.push(value);
                    }
                    Ok(Unique(Value::Array(values)))
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Unique, A::Error> {
                    let mut values = BTreeMap::new();
                    while let Some((key, Unique(value))) = map.next_entry::<String, Unique>()? {
                        if values.insert(key, value).is_some() {
                            return Err(de::Error::custom("duplicate JSON key"));
                        }
                    }
                    Ok(Unique(Value::Object(values.into_iter().collect())))
                }
            }
            deserializer.deserialize_any(JsonVisitor)
        }
    }
    serde_json::from_slice::<Unique>(bytes).map(|value| value.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str, contents: &str) -> Value {
        json!({"annotation": {"id": id, "type": 9, "pageIndex": 0,
            "rect": {"origin": {"x": 1, "y": 2}, "size": {"width": 3, "height": 4}},
            "contents": contents, "custom": {"opaque": [1, "x"]}},
            "ctx": {"data": {"opaque": "preserve verbatim value"}}})
    }

    #[test]
    fn item_identity_merge_preserves_context_and_deletes_unchanged_items() {
        let base =
            serde_json::to_vec(&vec![item("deleted", "old"), item("edited", "old")]).unwrap();
        let a = serde_json::to_vec(&vec![item("edited", "new"), item("a", "a")]).unwrap();
        let b = serde_json::to_vec(&vec![
            item("deleted", "old"),
            item("edited", "old"),
            item("b", "b"),
        ])
        .unwrap();
        let ab = merge(Some(&base), &a, &b).unwrap();
        assert!(!ab.conflicted);
        assert_eq!(ab.bytes, merge(Some(&base), &b, &a).unwrap().bytes);
        let values: Vec<Value> = serde_json::from_slice(&ab.bytes).unwrap();
        assert_eq!(
            values,
            vec![item("a", "a"), item("b", "b"), item("edited", "new")]
        );
    }

    #[test]
    fn ambiguous_items_are_reported_and_unknown_shapes_are_rejected() {
        let base = serde_json::to_vec(&vec![item("x", "base")]).unwrap();
        let edit = serde_json::to_vec(&vec![item("x", "edit")]).unwrap();
        let deleted = b"[]";
        let result = merge(Some(&base), &edit, deleted).unwrap();
        assert!(result.conflicted);
        assert_eq!(result.bytes, b"[]\n");
        let other = serde_json::to_vec(&vec![item("x", "other")]).unwrap();
        assert_eq!(
            merge(Some(&base), &edit, &other).unwrap().bytes,
            merge(Some(&base), &other, &edit).unwrap().bytes
        );
        for bad in [
            b"{}".as_slice(),
            b"[null]",
            b"[{\"annotation\":{\"id\":\"x\"}}]",
            b"[",
            b"{\"x\":1,\"x\":2}",
        ] {
            assert!(merge(None, &edit, bad).is_err());
        }
        let duplicates = serde_json::to_vec(&vec![item("x", "one"), item("x", "two")]).unwrap();
        assert!(merge(None, &edit, &duplicates).is_err());
    }
}
