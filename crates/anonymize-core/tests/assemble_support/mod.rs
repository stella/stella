use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value};

pub const BASELINE_FIXTURE: &str = "baseline-all-on";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedDelta {
  base: String,
  changes: Vec<ExpectedChange>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ExpectedChange {
  Array {
    path: Vec<String>,
    segments: Vec<ExpectedArraySegment>,
  },
  Remove {
    path: Vec<String>,
  },
  Set {
    path: Vec<String>,
    value: Value,
  },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ExpectedArraySegment {
  Copy { start: usize, end: usize },
  Values { values: Vec<Value> },
}

fn expected_path(dir: &Path, name: &str) -> PathBuf {
  if name == BASELINE_FIXTURE {
    return dir.join(format!("{name}.expected.json"));
  }
  dir.join(format!("{name}.expected.delta.json"))
}

fn read_value(path: &Path) -> Result<Value, String> {
  let text = fs::read_to_string(path)
    .map_err(|error| format!("read {}: {error}", path.display()))?;
  serde_json::from_str(&text)
    .map_err(|error| format!("parse {}: {error}", path.display()))
}

fn object_at_path_mut<'a>(
  mut value: &'a mut Value,
  path: &[String],
) -> Result<&'a mut Map<String, Value>, String> {
  for segment in path {
    value = value
      .as_object_mut()
      .and_then(|object| object.get_mut(segment))
      .ok_or_else(|| format!("delta path does not exist: {path:?}"))?;
  }
  value
    .as_object_mut()
    .ok_or_else(|| format!("delta path is not an object: {path:?}"))
}

fn apply_change(
  expected: &mut Value,
  change: ExpectedChange,
) -> Result<(), String> {
  match change {
    ExpectedChange::Array { mut path, segments } => {
      let key = path
        .pop()
        .ok_or_else(|| String::from("cannot replace the fixture root"))?;
      let parent = object_at_path_mut(expected, &path)?;
      let baseline = parent
        .get(&key)
        .and_then(Value::as_array)
        .ok_or_else(|| {
          format!("delta array path is not an array: {path:?}/{key}")
        })?
        .clone();
      let mut replacement = Vec::new();
      for segment in segments {
        match segment {
          ExpectedArraySegment::Copy { start, end } => {
            let values = baseline.get(start..end).ok_or_else(|| {
              format!(
                "delta copy range {start}..{end} exceeds array length {}",
                baseline.len()
              )
            })?;
            replacement.extend_from_slice(values);
          }
          ExpectedArraySegment::Values { values } => {
            replacement.extend(values);
          }
        }
      }
      parent.insert(key, Value::Array(replacement));
    }
    ExpectedChange::Remove { mut path } => {
      let key = path
        .pop()
        .ok_or_else(|| String::from("cannot remove the fixture root"))?;
      let parent = object_at_path_mut(expected, &path)?;
      if parent.remove(&key).is_none() {
        return Err(format!(
          "delta remove path does not exist: {path:?}/{key}"
        ));
      }
    }
    ExpectedChange::Set { mut path, value } => {
      let key = path
        .pop()
        .ok_or_else(|| String::from("cannot replace the fixture root"))?;
      object_at_path_mut(expected, &path)?.insert(key, value);
    }
  }
  Ok(())
}

pub fn read_expected_value(dir: &Path, name: &str) -> Result<Value, String> {
  if name == BASELINE_FIXTURE {
    return read_value(&expected_path(dir, name));
  }

  let delta_path = expected_path(dir, name);
  let delta: ExpectedDelta = {
    let text = fs::read_to_string(&delta_path)
      .map_err(|error| format!("read {}: {error}", delta_path.display()))?;
    serde_json::from_str(&text)
      .map_err(|error| format!("parse {}: {error}", delta_path.display()))?
  };
  if delta.base != BASELINE_FIXTURE {
    return Err(format!(
      "{}: unsupported delta base {:?}, expected {BASELINE_FIXTURE:?}",
      delta_path.display(),
      delta.base
    ));
  }

  let mut expected = read_value(&expected_path(dir, BASELINE_FIXTURE))?;
  for change in delta.changes {
    apply_change(&mut expected, change)?;
  }
  Ok(expected)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn delta_preserves_nulls_and_removes_fields() -> Result<(), String> {
    let mut reconstructed = serde_json::json!({
      "kept": {"value": 1, "removed": true},
      "changed": false,
      "items": [1, 2, 3]
    });
    let changes = [
      ExpectedChange::Array {
        path: vec![String::from("items")],
        segments: vec![
          ExpectedArraySegment::Copy { start: 1, end: 3 },
          ExpectedArraySegment::Values {
            values: vec![Value::from(4)],
          },
        ],
      },
      ExpectedChange::Remove {
        path: vec![String::from("kept"), String::from("removed")],
      },
      ExpectedChange::Set {
        path: vec![String::from("kept"), String::from("value")],
        value: Value::Null,
      },
      ExpectedChange::Set {
        path: vec![String::from("changed")],
        value: Value::Bool(true),
      },
    ];
    for change in changes {
      apply_change(&mut reconstructed, change)?;
    }
    assert_eq!(
      reconstructed,
      serde_json::json!({
        "kept": {"value": null},
        "changed": true,
        "items": [2, 3, 4]
      })
    );
    Ok(())
  }
}
