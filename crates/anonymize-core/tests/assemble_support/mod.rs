use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const BASELINE_FIXTURE: &str = "baseline-all-on";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ExpectedDelta {
  base: String,
  changes: Vec<ExpectedChange>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
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

fn read_expected_delta(
  dir: &Path,
  name: &str,
) -> Result<ExpectedDelta, String> {
  read_expected_delta_if_present(dir, name)?.ok_or_else(|| {
    format!(
      "read {}: file does not exist",
      expected_path(dir, name).display()
    )
  })
}

fn read_expected_delta_if_present(
  dir: &Path,
  name: &str,
) -> Result<Option<ExpectedDelta>, String> {
  let path = expected_path(dir, name);
  let text = match fs::read_to_string(&path) {
    Ok(text) => text,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      return Ok(None);
    }
    Err(error) => return Err(format!("read {}: {error}", path.display())),
  };
  let delta: ExpectedDelta = serde_json::from_str(&text)
    .map_err(|error| format!("parse {}: {error}", path.display()))?;
  if delta.base != BASELINE_FIXTURE {
    return Err(format!(
      "{}: unsupported delta base {:?}, expected {BASELINE_FIXTURE:?}",
      path.display(),
      delta.base
    ));
  }
  Ok(Some(delta))
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

fn value_key(value: &Value) -> Result<String, String> {
  serde_json::to_string(value)
    .map_err(|error| format!("serialize array item: {error}"))
}

fn push_copy_segment(
  segments: &mut Vec<ExpectedArraySegment>,
  start: usize,
  end: usize,
) {
  if let Some(ExpectedArraySegment::Copy {
    end: previous_end, ..
  }) = segments.last_mut()
    && *previous_end == start
  {
    *previous_end = end;
    return;
  }
  segments.push(ExpectedArraySegment::Copy { start, end });
}

fn push_value_segment(segments: &mut Vec<ExpectedArraySegment>, value: Value) {
  if let Some(ExpectedArraySegment::Values { values }) = segments.last_mut() {
    values.push(value);
    return;
  }
  segments.push(ExpectedArraySegment::Values {
    values: vec![value],
  });
}

fn array_segments(
  baseline: &[Value],
  actual: &[Value],
) -> Result<Vec<ExpectedArraySegment>, String> {
  let baseline_keys = baseline
    .iter()
    .map(value_key)
    .collect::<Result<Vec<_>, _>>()?;
  let mut baseline_indices = HashMap::<String, Vec<usize>>::new();
  for (index, key) in baseline_keys.iter().enumerate() {
    baseline_indices.entry(key.clone()).or_default().push(index);
  }
  let actual_keys = actual
    .iter()
    .map(value_key)
    .collect::<Result<Vec<_>, _>>()?;

  let mut segments = Vec::new();
  let mut remaining_actual = actual;
  let mut remaining_actual_keys = actual_keys.as_slice();
  let mut baseline_cursor = 0usize;
  while let (Some(actual_value), Some(key)) =
    (remaining_actual.first(), remaining_actual_keys.first())
  {
    if let Some(candidates) = baseline_indices.get(key)
      && let Some(&baseline_start) = candidates
        .get(candidates.partition_point(|index| *index < baseline_cursor))
        .or_else(|| candidates.first())
    {
      let baseline_tail =
        baseline_keys.get(baseline_start..).ok_or_else(|| {
          format!("baseline copy start {baseline_start} exceeds array length")
        })?;
      let length = baseline_tail
        .iter()
        .zip(remaining_actual_keys)
        .take_while(|(left, right)| left == right)
        .count();
      let baseline_end = baseline_start
        .checked_add(length)
        .ok_or_else(|| String::from("baseline copy end overflow"))?;
      push_copy_segment(&mut segments, baseline_start, baseline_end);
      baseline_cursor = baseline_end;
      remaining_actual = remaining_actual
        .get(length..)
        .ok_or_else(|| String::from("actual array copy exceeds length"))?;
      remaining_actual_keys = remaining_actual_keys
        .get(length..)
        .ok_or_else(|| String::from("actual array key copy exceeds length"))?;
      continue;
    }
    push_value_segment(&mut segments, actual_value.clone());
    remaining_actual = remaining_actual
      .get(1..)
      .ok_or_else(|| String::from("actual array advance exceeds length"))?;
    remaining_actual_keys = remaining_actual_keys
      .get(1..)
      .ok_or_else(|| String::from("actual array key advance exceeds length"))?;
  }
  Ok(segments)
}

fn build_changes(
  baseline: &Value,
  actual: &Value,
  path: &mut Vec<String>,
  changes: &mut Vec<ExpectedChange>,
) -> Result<(), String> {
  if baseline == actual {
    return Ok(());
  }

  match (baseline, actual) {
    (Value::Object(baseline), Value::Object(actual)) => {
      for (key, baseline_value) in baseline {
        path.push(key.clone());
        match actual.get(key) {
          Some(actual_value) => {
            build_changes(baseline_value, actual_value, path, changes)?;
          }
          None => changes.push(ExpectedChange::Remove { path: path.clone() }),
        }
        path.pop();
      }
      for (key, actual_value) in actual {
        if baseline.contains_key(key) {
          continue;
        }
        path.push(key.clone());
        changes.push(ExpectedChange::Set {
          path: path.clone(),
          value: actual_value.clone(),
        });
        path.pop();
      }
    }
    (Value::Array(baseline), Value::Array(actual)) => {
      changes.push(ExpectedChange::Array {
        path: path.clone(),
        segments: array_segments(baseline, actual)?,
      });
    }
    (_, actual) => changes.push(ExpectedChange::Set {
      path: path.clone(),
      value: actual.clone(),
    }),
  }
  Ok(())
}

pub fn write_expected_delta(
  dir: &Path,
  name: &str,
  baseline: &Value,
  actual: &Value,
) -> Result<(), String> {
  if name == BASELINE_FIXTURE {
    return Err(String::from(
      "refusing to generate the independent baseline oracle",
    ));
  }

  let mut changes = Vec::new();
  build_changes(baseline, actual, &mut Vec::new(), &mut changes)?;
  let delta = ExpectedDelta {
    base: String::from(BASELINE_FIXTURE),
    changes,
  };
  let mut reconstructed = baseline.clone();
  for change in delta.changes.clone() {
    apply_change(&mut reconstructed, change)?;
  }
  if reconstructed != *actual {
    return Err(format!(
      "{name}: generated delta does not reconstruct the actual config"
    ));
  }

  let path = expected_path(dir, name);
  let mut serialized = serde_json::to_string_pretty(&delta)
    .map_err(|error| format!("serialize {}: {error}", path.display()))?;
  serialized.push('\n');
  fs::write(&path, serialized)
    .map_err(|error| format!("write {}: {error}", path.display()))
}

fn is_omittable_serialized_default(value: &Value) -> bool {
  value.is_null()
    || value.as_array().is_some_and(Vec::is_empty)
    || value.as_object().is_some_and(Map::is_empty)
}

fn omission_identity_value(value: &Value) -> Value {
  match value {
    Value::Object(object) => Value::Object(
      object
        .iter()
        .filter_map(|(key, member)| {
          let normalized = omission_identity_value(member);
          (!is_omittable_serialized_default(&normalized))
            .then(|| (key.clone(), normalized))
        })
        .collect(),
    ),
    Value::Array(array) => {
      Value::Array(array.iter().map(omission_identity_value).collect())
    }
    _ => value.clone(),
  }
}

fn array_identity_groups(
  values: &[Value],
) -> Result<HashMap<String, Vec<usize>>, String> {
  let mut identities = HashMap::<String, Vec<usize>>::new();
  for (index, value) in values.iter().enumerate() {
    let identity = value_key(&omission_identity_value(value))?;
    identities.entry(identity).or_default().push(index);
  }
  Ok(identities)
}

fn uniform_group_value<'a>(
  values: &'a [Value],
  indices: &[usize],
  identity: &str,
) -> Result<&'a Value, String> {
  let first_index = indices
    .first()
    .ok_or_else(|| format!("omission identity {identity} has no indices"))?;
  let first = values.get(*first_index).ok_or_else(|| {
    format!("omission identity index {first_index} disappeared")
  })?;
  for index in indices.iter().skip(1) {
    let value = values
      .get(*index)
      .ok_or_else(|| format!("omission identity index {index} disappeared"))?;
    if value != first {
      return Err(format!(
        "cannot classify omissions for ambiguous array identity {identity}"
      ));
    }
  }
  Ok(first)
}

fn preserve_omissions_from_oracle(
  actual: &mut Value,
  historical_expected: &Value,
  historical_baseline: Option<&Value>,
) -> Result<(), String> {
  match (actual, historical_expected) {
    (Value::Object(actual), Value::Object(expected)) => {
      let baseline = historical_baseline.and_then(Value::as_object);
      actual.retain(|key, value| {
        expected.contains_key(key)
          || !baseline.is_some_and(|baseline| baseline.contains_key(key))
          || !is_omittable_serialized_default(value)
      });
      for (key, value) in actual {
        if let Some(expected_value) = expected.get(key) {
          preserve_omissions_from_oracle(
            value,
            expected_value,
            baseline.and_then(|baseline| baseline.get(key)),
          )?;
        }
      }
    }
    (Value::Array(actual), Value::Array(expected)) => {
      let actual_groups = array_identity_groups(actual)?;
      let expected_groups = array_identity_groups(expected)?;
      let baseline_array = historical_baseline.and_then(Value::as_array);
      let baseline_groups = baseline_array
        .map(|baseline| array_identity_groups(baseline))
        .transpose()?;
      for (identity, actual_indices) in actual_groups {
        let Some(expected_indices) = expected_groups.get(&identity) else {
          continue;
        };
        let expected_value =
          uniform_group_value(expected, expected_indices, &identity)?;
        let baseline_value = baseline_array
          .zip(baseline_groups.as_ref())
          .and_then(|(baseline, groups)| {
            groups
              .get(&identity)
              .map(|indices| uniform_group_value(baseline, indices, &identity))
          })
          .transpose()?;
        for actual_index in actual_indices {
          let actual_value = actual.get_mut(actual_index).ok_or_else(|| {
            format!("actual omission identity index {actual_index} disappeared")
          })?;
          preserve_omissions_from_oracle(
            actual_value,
            expected_value,
            baseline_value,
          )?;
        }
      }
    }
    _ => {}
  }
  Ok(())
}

fn repository_root() -> Result<PathBuf, String> {
  let output = Command::new("git")
    .args(["rev-parse", "--show-toplevel"])
    .current_dir(env!("CARGO_MANIFEST_DIR"))
    .output()
    .map_err(|error| format!("run git rev-parse: {error}"))?;
  if !output.status.success() {
    let stderr = std::str::from_utf8(&output.stderr)
      .map_err(|error| format!("git rev-parse stderr is not UTF-8: {error}"))?;
    return Err(format!("git rev-parse failed: {}", stderr.trim()));
  }
  let root = String::from_utf8(output.stdout)
    .map_err(|error| format!("git root is not UTF-8: {error}"))?;
  Ok(PathBuf::from(root.trim()))
}

fn read_committed_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
  let root = repository_root()?;
  let relative = path.strip_prefix(&root).map_err(|_| {
    format!(
      "{} is outside repository {}",
      path.display(),
      root.display()
    )
  })?;
  let relative = relative.to_str().ok_or_else(|| {
    format!("repository path is not UTF-8: {}", relative.display())
  })?;
  let listed = Command::new("git")
    .args(["ls-tree", "--name-only", "HEAD", "--", relative])
    .current_dir(&root)
    .output()
    .map_err(|error| format!("list committed {relative}: {error}"))?;
  if !listed.status.success() {
    let stderr = std::str::from_utf8(&listed.stderr)
      .map_err(|error| format!("git ls-tree stderr is not UTF-8: {error}"))?;
    return Err(format!("list committed {relative}: {}", stderr.trim()));
  }
  if listed.stdout.is_empty() {
    return Ok(None);
  }
  let object = format!("HEAD:{relative}");
  let shown = Command::new("git")
    .args(["show", &object])
    .current_dir(&root)
    .output()
    .map_err(|error| format!("read committed {relative}: {error}"))?;
  if !shown.status.success() {
    let stderr = std::str::from_utf8(&shown.stderr)
      .map_err(|error| format!("git show stderr is not UTF-8: {error}"))?;
    return Err(format!("read committed {relative}: {}", stderr.trim()));
  }
  Ok(Some(shown.stdout))
}

fn read_committed_value(path: &Path) -> Result<Value, String> {
  let bytes = read_committed_file(path)?
    .ok_or_else(|| format!("{} is not committed", path.display()))?;
  serde_json::from_slice(&bytes)
    .map_err(|error| format!("parse committed {}: {error}", path.display()))
}

fn read_committed_delta(
  dir: &Path,
  name: &str,
) -> Result<Option<ExpectedDelta>, String> {
  let path = expected_path(dir, name);
  let Some(bytes) = read_committed_file(&path)? else {
    return Ok(None);
  };
  let delta: ExpectedDelta = serde_json::from_slice(&bytes)
    .map_err(|error| format!("parse committed {}: {error}", path.display()))?;
  if delta.base != BASELINE_FIXTURE {
    return Err(format!(
      "{}: unsupported committed delta base {:?}",
      path.display(),
      delta.base
    ));
  }
  Ok(Some(delta))
}

fn reconstruct_expected(
  historical_baseline: &Value,
  delta: &ExpectedDelta,
) -> Result<Value, String> {
  let mut historical_expected = historical_baseline.clone();
  for change in delta.changes.clone() {
    apply_change(&mut historical_expected, change)?;
  }
  Ok(historical_expected)
}

/// Applies omission-only information from a prior frozen delta.
///
/// This retains intentional JSON omissions that serde represents as `null`,
/// `[]`, or `{}` without applying the stale delta to the new baseline.
pub fn preserve_omission_oracle(
  dir: &Path,
  name: &str,
  actual: &mut Value,
) -> Result<(), String> {
  if name == BASELINE_FIXTURE {
    return Ok(());
  }
  let Some(delta) = read_committed_delta(dir, name)? else {
    return Ok(());
  };
  let historical_baseline =
    read_committed_value(&expected_path(dir, BASELINE_FIXTURE))?;
  let historical_expected = reconstruct_expected(&historical_baseline, &delta)
    .map_err(|error| {
      format!("{name}: committed omission oracle is invalid: {error}")
    })?;
  preserve_omissions_from_oracle(
    actual,
    &historical_expected,
    Some(&historical_baseline),
  )
}

pub fn read_expected_value(dir: &Path, name: &str) -> Result<Value, String> {
  if name == BASELINE_FIXTURE {
    return read_value(&expected_path(dir, name));
  }

  let delta = read_expected_delta(dir, name)?;

  let mut expected = read_value(&expected_path(dir, BASELINE_FIXTURE))?;
  for change in delta.changes {
    apply_change(&mut expected, change)?;
  }
  Ok(expected)
}

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::*;

  fn structural_snapshot(member: Option<Value>) -> Value {
    let mut object = Map::new();
    if let Some(member) = member {
      object.insert(String::from("member"), member);
    }
    Value::Object(object)
  }

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

  #[test]
  fn generated_delta_round_trips_reordered_and_inserted_arrays()
  -> Result<(), String> {
    let baseline = serde_json::json!({
      "kept": true,
      "removed": 1,
      "items": ["a", "b", "c", "d"]
    });
    let actual = serde_json::json!({
      "kept": false,
      "added": 2,
      "items": ["c", "d", "new", "a"]
    });
    let mut changes = Vec::new();
    build_changes(&baseline, &actual, &mut Vec::new(), &mut changes)?;
    let mut reconstructed = baseline;
    for change in changes {
      apply_change(&mut reconstructed, change)?;
    }
    assert_eq!(reconstructed, actual);
    Ok(())
  }

  #[test]
  fn generated_delta_preserves_absent_null_and_empty_members()
  -> Result<(), String> {
    let baseline = serde_json::json!({
      "removed_null": null,
      "removed_array": [],
      "removed_object": {},
      "nested": {
        "removed_null": null,
        "removed_array": [],
        "removed_object": {}
      }
    });
    let actual = serde_json::json!({
      "added_null": null,
      "added_array": [],
      "added_object": {},
      "nested": {
        "added_null": null,
        "added_array": [],
        "added_object": {}
      }
    });
    let mut changes = Vec::new();
    build_changes(&baseline, &actual, &mut Vec::new(), &mut changes)?;

    let mut reconstructed = baseline;
    for change in changes {
      apply_change(&mut reconstructed, change)?;
    }
    assert_eq!(reconstructed, actual);
    Ok(())
  }

  #[test]
  fn omission_oracle_preserves_omitted_null_and_empty_members()
  -> Result<(), String> {
    let mut actual = serde_json::json!({
      "omitted_null": null,
      "explicit_null": null,
      "omitted_array": [],
      "explicit_array": [],
      "nested": {
        "omitted_object": {},
        "explicit_object": {}
      }
    });
    let oracle = serde_json::json!({
      "explicit_null": null,
      "explicit_array": [],
      "nested": {"explicit_object": {}}
    });
    let baseline = serde_json::json!({
      "omitted_null": null,
      "explicit_null": null,
      "omitted_array": [],
      "explicit_array": [],
      "nested": {
        "omitted_object": {},
        "explicit_object": {}
      }
    });
    preserve_omissions_from_oracle(&mut actual, &oracle, Some(&baseline))?;
    assert_eq!(
      actual,
      serde_json::json!({
        "explicit_null": null,
        "explicit_array": [],
        "nested": {"explicit_object": {}}
      })
    );
    Ok(())
  }

  #[test]
  fn omission_oracle_aligns_reordered_arrays_by_identity() -> Result<(), String>
  {
    let mut actual = serde_json::json!([
      {"id": "second", "optional": null},
      {"id": "inserted", "optional": null},
      {"id": "first", "optional": null}
    ]);
    let oracle = serde_json::json!([
      {"id": "first"},
      {"id": "second", "optional": null}
    ]);
    let baseline = serde_json::json!([
      {"id": "first", "optional": null},
      {"id": "second", "optional": null}
    ]);

    preserve_omissions_from_oracle(&mut actual, &oracle, Some(&baseline))?;

    assert_eq!(
      actual,
      serde_json::json!([
        {"id": "second", "optional": null},
        {"id": "inserted", "optional": null},
        {"id": "first"}
      ])
    );
    Ok(())
  }

  #[test]
  fn omission_oracle_fails_closed_for_duplicate_identity_shapes()
  -> Result<(), String> {
    let mut actual = serde_json::json!([
      {"id": "duplicate", "optional": null},
      {"id": "duplicate", "optional": null}
    ]);
    let oracle = serde_json::json!([
      {"id": "duplicate"},
      {"id": "duplicate", "optional": null}
    ]);
    let baseline = serde_json::json!([
      {"id": "duplicate", "optional": null},
      {"id": "duplicate", "optional": null}
    ]);

    let error = match preserve_omissions_from_oracle(
      &mut actual,
      &oracle,
      Some(&baseline),
    ) {
      Ok(()) => {
        return Err(String::from(
          "ambiguous historical shapes did not fail closed",
        ));
      }
      Err(error) => error,
    };

    assert!(error.contains("ambiguous array identity"));
    Ok(())
  }

  #[test]
  fn omission_oracle_keeps_new_explicit_defaults() -> Result<(), String> {
    let mut actual = serde_json::json!({
      "historically_omitted": null,
      "new_null": null,
      "new_array": [],
      "new_object": {}
    });
    let historical_expected = serde_json::json!({});
    let historical_baseline = serde_json::json!({
      "historically_omitted": null
    });

    preserve_omissions_from_oracle(
      &mut actual,
      &historical_expected,
      Some(&historical_baseline),
    )?;

    assert_eq!(
      actual,
      serde_json::json!({
        "new_null": null,
        "new_array": [],
        "new_object": {}
      })
    );
    Ok(())
  }

  #[test]
  fn committed_array_copies_use_historical_baseline_identities()
  -> Result<(), String> {
    let historical_baseline = serde_json::json!({
      "items": [
        {"id": "first", "optional": null},
        {"id": "second", "optional": null}
      ]
    });
    let delta = ExpectedDelta {
      base: String::from(BASELINE_FIXTURE),
      changes: vec![ExpectedChange::Array {
        path: vec![String::from("items")],
        segments: vec![
          ExpectedArraySegment::Copy { start: 1, end: 2 },
          ExpectedArraySegment::Values {
            values: vec![serde_json::json!({"id": "first"})],
          },
        ],
      }],
    };
    let historical_expected =
      reconstruct_expected(&historical_baseline, &delta)?;
    assert_eq!(
      historical_expected,
      serde_json::json!({
        "items": [
          {"id": "second", "optional": null},
          {"id": "first"}
        ]
      })
    );

    let mut actual = serde_json::json!({
      "items": [
        {"id": "second", "optional": null},
        {"id": "inserted", "optional": []},
        {"id": "first", "optional": null}
      ]
    });
    preserve_omissions_from_oracle(
      &mut actual,
      &historical_expected,
      Some(&historical_baseline),
    )?;
    assert_eq!(
      actual,
      serde_json::json!({
        "items": [
          {"id": "second", "optional": null},
          {"id": "inserted", "optional": []},
          {"id": "first"}
        ]
      })
    );
    Ok(())
  }

  #[test]
  fn invalid_committed_delta_fails_closed() {
    let baseline = serde_json::json!({"kept": true});
    let delta = ExpectedDelta {
      base: String::from(BASELINE_FIXTURE),
      changes: vec![ExpectedChange::Remove {
        path: vec![String::from("missing")],
      }],
    };

    assert!(reconstruct_expected(&baseline, &delta).is_err());
  }

  #[test]
  fn missing_omission_oracle_leaves_new_fixture_unchanged() -> Result<(), String>
  {
    let dir =
      Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/assemble");
    let mut actual = serde_json::json!({
      "null_member": null,
      "array_member": [],
      "object_member": {}
    });
    let expected = actual.clone();

    preserve_omission_oracle(&dir, "new-fixture", &mut actual)?;

    assert_eq!(actual, expected);
    Ok(())
  }

  proptest! {
    #[test]
    fn generated_delta_round_trips_each_structural_member_state(
      baseline_member in prop_oneof![
        Just(None),
        Just(Some(Value::Null)),
        Just(Some(Value::Array(Vec::new()))),
        Just(Some(Value::Object(Map::new()))),
      ],
      actual_member in prop_oneof![
        Just(None),
        Just(Some(Value::Null)),
        Just(Some(Value::Array(Vec::new()))),
        Just(Some(Value::Object(Map::new()))),
      ],
    ) {
      let baseline = structural_snapshot(baseline_member);
      let actual = structural_snapshot(actual_member);
      let mut changes = Vec::new();
      prop_assert!(
        build_changes(&baseline, &actual, &mut Vec::new(), &mut changes).is_ok()
      );
      let mut reconstructed = baseline;
      for change in changes {
        prop_assert!(apply_change(&mut reconstructed, change).is_ok());
      }
      prop_assert_eq!(reconstructed, actual);
    }

    #[test]
    fn omission_oracle_shape_follows_identity_across_reordering(
      entries in proptest::collection::btree_map(0_u16..1_000, any::<bool>(), 1..20),
    ) {
      let oracle = Value::Array(
        entries
          .iter()
          .map(|(id, explicit)| {
            if *explicit {
              serde_json::json!({"id": id, "optional": null})
            } else {
              serde_json::json!({"id": id})
            }
          })
          .collect(),
      );
      let mut actual = Value::Array(
        entries
          .keys()
          .rev()
          .map(|id| {
            serde_json::json!({
              "id": id,
              "optional": null,
              "new_optional": []
            })
          })
          .collect(),
      );

      let baseline = Value::Array(
        entries
          .keys()
          .map(|id| serde_json::json!({"id": id, "optional": null}))
          .collect(),
      );
      prop_assert!(
        preserve_omissions_from_oracle(&mut actual, &oracle, Some(&baseline))
          .is_ok()
      );
      let Value::Array(actual_entries) = actual else {
        return Err(TestCaseError::fail("actual array changed type"));
      };
      for entry in actual_entries {
        let id = entry
          .get("id")
          .and_then(Value::as_u64)
          .ok_or_else(|| TestCaseError::fail("array identity disappeared"))?;
        let id = u16::try_from(id)
          .map_err(|_| TestCaseError::fail("array identity exceeded u16"))?;
        let explicit = entries
          .get(&id)
          .ok_or_else(|| TestCaseError::fail("unexpected array identity"))?;
        prop_assert_eq!(entry.get("optional").is_some(), *explicit);
        prop_assert_eq!(entry.get("new_optional"), Some(&Value::Array(vec![])));
      }
    }
  }

  #[test]
  fn array_delta_stops_at_a_shared_suffix() -> Result<(), String> {
    let baseline = vec![Value::from("prefix"), Value::from("suffix")];
    let actual = vec![Value::from("suffix")];
    let segments = array_segments(&baseline, &actual)?;
    let mut reconstructed = serde_json::json!({"items": baseline});
    apply_change(
      &mut reconstructed,
      ExpectedChange::Array {
        path: vec![String::from("items")],
        segments,
      },
    )?;
    assert_eq!(reconstructed, serde_json::json!({"items": actual}));
    Ok(())
  }
}
