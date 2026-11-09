//! The speech model runs in a child process of this same executable, so a
//! native crash cannot take clipboard or activity tracking down with it, and
//! closing the child returns the model's memory.
//!
//! One request is a JSON header line followed by raw little-endian `f32`
//! samples; one response is a JSON line. Closing stdin ends the process.
//! Audio and text exist only in memory here and are never logged.

use std::{
  io::{self, BufRead, Write},
  path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

pub const WORKER_ARG: &str = "--dictation-worker";
/// Ten minutes at the model's rate.
pub const MAX_SAMPLES: usize = 9_600_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestHeader {
  pub model_path: PathBuf,
  pub samples: usize,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum Response {
  Text(String),
  Failed,
}

pub fn write_request(
  output: &mut impl Write,
  model_path: &Path,
  samples: &[f32],
) -> io::Result<()> {
  let header = RequestHeader {
    model_path: model_path.to_path_buf(),
    samples: samples.len(),
  };
  serde_json::to_writer(&mut *output, &header)?;
  output.write_all(b"\n")?;
  let bytes = samples
    .iter()
    .flat_map(|sample| sample.to_le_bytes())
    .collect::<Vec<_>>();
  output.write_all(&bytes)?;
  output.flush()
}

pub fn read_response(input: &mut impl BufRead) -> io::Result<Response> {
  let mut line = String::new();
  if input.read_line(&mut line)? == 0 {
    return Err(io::ErrorKind::UnexpectedEof.into());
  }
  serde_json::from_str(&line).map_err(io::Error::other)
}

/// Answers requests until the parent closes stdin.
fn serve(
  input: &mut impl BufRead,
  output: &mut impl Write,
  mut transcribe: impl FnMut(&Path, &[f32]) -> Option<String>,
) -> io::Result<()> {
  let mut line = String::new();
  loop {
    line.clear();
    if input.read_line(&mut line)? == 0 {
      return Ok(());
    }
    let header: RequestHeader =
      serde_json::from_str(&line).map_err(io::Error::other)?;
    if header.samples > MAX_SAMPLES {
      return Err(io::ErrorKind::InvalidData.into());
    }
    let mut bytes = vec![0; header.samples * size_of::<f32>()];
    input.read_exact(&mut bytes)?;
    let (frames, _) = bytes.as_chunks::<{ size_of::<f32>() }>();
    let samples = frames
      .iter()
      .copied()
      .map(f32::from_le_bytes)
      .collect::<Vec<_>>();
    let response =
      transcribe(&header.model_path, &samples).map_or(Response::Failed, Response::Text);
    serde_json::to_writer(&mut *output, &response)?;
    output.write_all(b"\n")?;
    output.flush()?;
  }
}

#[cfg(dictation)]
mod engine {
  use std::path::{Path, PathBuf};

  use transcribe_cpp::{Model, RunOptions, Session};

  /// The loaded model stays warm between requests of one worker.
  #[derive(Default)]
  pub struct Engine(Option<(PathBuf, Session)>);

  impl Engine {
    pub fn transcribe(&mut self, model_path: &Path, pcm: &[f32]) -> Option<String> {
      if self.0.as_ref().is_none_or(|(path, _)| path != model_path) {
        let session = Model::load(model_path).ok()?.session().ok()?;
        self.0 = Some((model_path.to_path_buf(), session));
      }
      let (_, session) = self.0.as_mut()?;
      let transcript = session.run(pcm, &RunOptions::default()).ok()?;
      Some(transcript.text)
    }
  }
}

/// Serves as the worker when the process was started as one, and returns its
/// exit code; `None` for an ordinary launch.
#[cfg(dictation)]
pub fn run_if_requested(args: &[std::ffi::OsString]) -> Option<i32> {
  if args.get(1).is_none_or(|arg| arg != WORKER_ARG) {
    return None;
  }
  let mut engine = engine::Engine::default();
  let served = serve(
    &mut io::stdin().lock(),
    &mut io::stdout().lock(),
    |model_path, pcm| engine.transcribe(model_path, pcm),
  );
  Some(i32::from(served.is_err()))
}

#[cfg(test)]
mod tests {
  use std::io::Cursor;

  use super::*;

  fn request(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::new();
    write_request(&mut bytes, Path::new("/model.gguf"), samples).unwrap();
    bytes
  }

  #[test]
  fn serves_each_request_with_its_samples() {
    let mut input = request(&[0.25, -0.5]);
    input.extend(request(&[1.0]));
    let mut output = Vec::new();
    let mut seen = Vec::new();

    serve(&mut Cursor::new(input), &mut output, |path, pcm| {
      seen.push((path.to_path_buf(), pcm.to_vec()));
      Some(format!("{}", pcm.len()))
    })
    .unwrap();

    assert_eq!(
      seen,
      vec![
        (PathBuf::from("/model.gguf"), vec![0.25, -0.5]),
        (PathBuf::from("/model.gguf"), vec![1.0]),
      ]
    );
    let mut replies = Cursor::new(output);
    assert_eq!(
      read_response(&mut replies).unwrap(),
      Response::Text("2".to_string())
    );
    assert_eq!(
      read_response(&mut replies).unwrap(),
      Response::Text("1".to_string())
    );
  }

  #[test]
  fn reports_a_failed_transcription_and_keeps_serving() {
    let mut input = request(&[0.0]);
    input.extend(request(&[0.0]));
    let mut output = Vec::new();
    let mut calls = 0;

    serve(&mut Cursor::new(input), &mut output, |_, _| {
      calls += 1;
      (calls > 1).then(|| "ok".to_string())
    })
    .unwrap();

    let mut replies = Cursor::new(output);
    assert_eq!(read_response(&mut replies).unwrap(), Response::Failed);
    assert_eq!(
      read_response(&mut replies).unwrap(),
      Response::Text("ok".to_string())
    );
  }

  #[test]
  fn closed_stdin_ends_cleanly() {
    let mut output = Vec::new();

    let served = serve(&mut Cursor::new(Vec::new()), &mut output, |_, _| None);

    assert!(served.is_ok());
    assert!(output.is_empty());
  }

  #[test]
  fn refuses_an_oversized_request_before_allocating() {
    let header = format!(
      "{}\n",
      serde_json::json!({ "modelPath": "/m", "samples": MAX_SAMPLES + 1 })
    );

    let served = serve(&mut Cursor::new(header), &mut Vec::new(), |_, _| None);

    assert_eq!(served.unwrap_err().kind(), io::ErrorKind::InvalidData);
  }

  #[test]
  fn a_truncated_body_is_an_error_not_a_transcription() {
    let mut input = request(&[0.0, 0.0]);
    input.truncate(input.len() - 1);

    let served = serve(&mut Cursor::new(input), &mut Vec::new(), |_, _| {
      panic!("truncated audio reached the model")
    });

    assert!(served.is_err());
  }

  #[test]
  fn a_dead_worker_reads_as_an_error() {
    assert!(read_response(&mut Cursor::new(Vec::new())).is_err());
  }
}
