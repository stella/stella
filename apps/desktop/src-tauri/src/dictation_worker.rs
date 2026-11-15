//! The speech model runs in a child process of this same executable, so a
//! native crash cannot take clipboard or activity tracking down with it, and
//! closing the child returns the model's memory.
//!
//! One request is a JSON header line followed by raw little-endian `f32`
//! samples; one response is a JSON line. Closing stdin ends the process.
//! Audio and text exist only in memory here and are never logged.
//!
//! The user waits on every request, so on macOS the worker runs as
//! user-initiated work and on Windows above normal priority: a busy machine
//! must not starve a dictation the speaker is waiting for.

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
  /// A language hint, passed on only when the loaded model lists it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub language: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum Response {
  Text(String),
  Failed,
}

/// One answer, with the compute backend the loaded model runs on (a short
/// code such as `metal` or `cpu`), when one is loaded.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reply {
  pub response: Response,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub backend: Option<String>,
}

pub fn write_request(
  output: &mut impl Write,
  model_path: &Path,
  samples: &[f32],
  language: Option<&str>,
) -> io::Result<()> {
  let header = RequestHeader {
    model_path: model_path.to_path_buf(),
    samples: samples.len(),
    language: language.map(ToString::to_string),
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

pub fn read_response(input: &mut impl BufRead) -> io::Result<Reply> {
  let mut line = String::new();
  if input.read_line(&mut line)? == 0 {
    return Err(io::ErrorKind::UnexpectedEof.into());
  }
  serde_json::from_str(&line).map_err(io::Error::other)
}

/// What one request produced: the text, or `None`, and the backend.
pub type Transcribed = (Option<String>, Option<String>);

/// Answers requests until the parent closes stdin.
fn serve(
  input: &mut impl BufRead,
  output: &mut impl Write,
  mut transcribe: impl FnMut(&Path, &[f32], Option<&str>) -> Transcribed,
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
    let (text, backend) =
      transcribe(&header.model_path, &samples, header.language.as_deref());
    let reply = Reply {
      response: text.map_or(Response::Failed, Response::Text),
      backend,
    };
    serde_json::to_writer(&mut *output, &reply)?;
    output.write_all(b"\n")?;
    output.flush()?;
  }
}

#[cfg(dictation)]
mod engine {
  use std::path::{Path, PathBuf};

  use transcribe_cpp::{Model, RunOptions, Session};

  struct Loaded {
    path: PathBuf,
    session: Session,
    backend: String,
    /// Empty when the model is language-agnostic.
    languages: Vec<String>,
  }

  /// The loaded model stays warm between requests of one worker.
  #[derive(Default)]
  pub struct Engine(Option<Loaded>);

  impl Engine {
    fn load(&mut self, model_path: &Path) -> Option<&mut Loaded> {
      if self
        .0
        .as_ref()
        .is_none_or(|loaded| loaded.path != model_path)
      {
        let model = Model::load(model_path).ok()?;
        let languages = model
          .capabilities()
          .map(|capabilities| capabilities.languages)
          .unwrap_or_default();
        let backend = model.backend();
        self.0 = Some(Loaded {
          path: model_path.to_path_buf(),
          session: model.session().ok()?,
          backend,
          languages,
        });
      }
      self.0.as_mut()
    }

    pub fn transcribe(
      &mut self,
      model_path: &Path,
      pcm: &[f32],
      language: Option<&str>,
    ) -> super::Transcribed {
      let Some(loaded) = self.load(model_path) else {
        return (None, None);
      };
      // A hint the model does not list would fail the run, so it is dropped.
      let language = language
        .filter(|hint| loaded.languages.iter().any(|listed| listed == hint))
        .map(ToString::to_string);
      let options = RunOptions {
        language,
        ..RunOptions::default()
      };
      let text = loaded
        .session
        .run(pcm, &options)
        .ok()
        .map(|transcript| transcript.text);
      (text, Some(loaded.backend.clone()))
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
  // Before the model loads, so its threads start from the same class.
  #[cfg(target_os = "macos")]
  let _scheduled: bool = stella_desktop_macos::prefer_user_initiated();
  let mut engine = engine::Engine::default();
  let served = serve(
    &mut io::stdin().lock(),
    &mut io::stdout().lock(),
    |model_path, pcm, language| engine.transcribe(model_path, pcm, language),
  );
  Some(i32::from(served.is_err()))
}

#[cfg(test)]
mod tests {
  use std::io::Cursor;

  use super::*;

  fn request(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::new();
    write_request(&mut bytes, Path::new("/model.gguf"), samples, None).unwrap();
    bytes
  }

  #[test]
  fn serves_each_request_with_its_samples() {
    let mut input = request(&[0.25, -0.5]);
    input.extend(request(&[1.0]));
    let mut output = Vec::new();
    let mut seen = Vec::new();

    serve(&mut Cursor::new(input), &mut output, |path, pcm, _| {
      seen.push((path.to_path_buf(), pcm.to_vec()));
      (Some(format!("{}", pcm.len())), Some("cpu".to_string()))
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
      Reply {
        response: Response::Text("2".to_string()),
        backend: Some("cpu".to_string()),
      }
    );
    assert_eq!(
      read_response(&mut replies).unwrap().response,
      Response::Text("1".to_string())
    );
  }

  #[test]
  fn reports_a_failed_transcription_and_keeps_serving() {
    let mut input = request(&[0.0]);
    input.extend(request(&[0.0]));
    let mut output = Vec::new();
    let mut calls = 0;

    serve(&mut Cursor::new(input), &mut output, |_, _, _| {
      calls += 1;
      ((calls > 1).then(|| "ok".to_string()), None)
    })
    .unwrap();

    let mut replies = Cursor::new(output);
    assert_eq!(
      read_response(&mut replies).unwrap().response,
      Response::Failed
    );
    assert_eq!(
      read_response(&mut replies).unwrap().response,
      Response::Text("ok".to_string())
    );
  }

  #[test]
  fn closed_stdin_ends_cleanly() {
    let mut output = Vec::new();

    let served = serve(&mut Cursor::new(Vec::new()), &mut output, |_, _, _| {
      (None, None)
    });

    assert!(served.is_ok());
    assert!(output.is_empty());
  }

  #[test]
  fn refuses_an_oversized_request_before_allocating() {
    let header = format!(
      "{}\n",
      serde_json::json!({ "modelPath": "/m", "samples": MAX_SAMPLES + 1 })
    );

    let served = serve(&mut Cursor::new(header), &mut Vec::new(), |_, _, _| {
      (None, None)
    });

    assert_eq!(served.unwrap_err().kind(), io::ErrorKind::InvalidData);
  }

  #[test]
  fn a_truncated_body_is_an_error_not_a_transcription() {
    let mut input = request(&[0.0, 0.0]);
    input.truncate(input.len() - 1);

    let served = serve(&mut Cursor::new(input), &mut Vec::new(), |_, _, _| {
      panic!("truncated audio reached the model")
    });

    assert!(served.is_err());
  }

  #[test]
  fn the_language_hint_reaches_the_model_side_unchanged() {
    let mut input = Vec::new();
    write_request(&mut input, Path::new("/m"), &[0.0], Some("cs")).unwrap();
    input.extend(request(&[0.0]));
    let mut hints = Vec::new();

    serve(
      &mut Cursor::new(input),
      &mut Vec::new(),
      |_, _, language| {
        hints.push(language.map(ToString::to_string));
        (None, None)
      },
    )
    .unwrap();

    assert_eq!(hints, vec![Some("cs".to_string()), None]);
  }

  #[test]
  fn a_dead_worker_reads_as_an_error() {
    assert!(read_response(&mut Cursor::new(Vec::new())).is_err());
  }
}
