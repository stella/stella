//! A stored recording read the way the desktop reads one: detected from its
//! first bytes, decoded to one channel, cut into pieces at pauses and handed
//! out one at a time as 16 kHz mono PCM WAV, short enough for one
//! transcription request.
//!
//! The recording's bytes are written into WebAssembly memory once, in
//! slices, so the caller never holds a second copy. Decoding is pulled: a
//! piece is decoded only when [`RecordingPieces::next`] is called, so the
//! work spreads over the transcription instead of arriving as one burst.

use std::{collections::VecDeque, io::Cursor};

use stella_desktop_recording::{
  self as recording, Detected, Format, MonoSource, Piece, PieceRules, Pieces, Refusal,
  SymphoniaSource,
};
use symphonia_core::io::{MediaSourceStream, MediaSourceStreamOptions};
use wasm_bindgen::prelude::*;

/// A header may round the length; the desktop allows the same margin.
const DURATION_TOLERANCE_MS: u64 = 2_000;
const WAV_HEADER_BYTES: usize = 44;

/// Why a recording is not transcribed, as the API names it.
mod refusal {
  pub const UNSUPPORTED: &str = "unsupported";
  pub const UNREADABLE: &str = "unreadable";
  pub const TOO_LONG: &str = "too_long";
  pub const DICTAPHONE: &str = "dictaphone";
}

fn refused(code: &str) -> JsError {
  JsError::new(code)
}

/// The recording's bytes, written in slices before it is opened.
#[wasm_bindgen]
pub struct RecordingBytes {
  bytes: Vec<u8>,
}

#[wasm_bindgen]
impl RecordingBytes {
  /// Room for a recording of `length` bytes.
  #[wasm_bindgen(constructor)]
  pub fn new(length: usize) -> Self {
    Self {
      bytes: vec![0; length],
    }
  }

  /// Copies `slice` in at `offset`; `false` when it does not fit.
  pub fn write(&mut self, offset: usize, slice: &[u8]) -> bool {
    let Some(end) = offset.checked_add(slice.len()) else {
      return false;
    };
    let Some(target) = self.bytes.get_mut(offset..end) else {
      return false;
    };
    target.copy_from_slice(slice);
    true
  }
}

/// One piece of the recording, ready for a transcription request.
#[wasm_bindgen]
pub struct RecordingPiece {
  index: usize,
  start_ms: u64,
  end_ms: u64,
  pause_before_ms: u64,
  speech: bool,
  wav: Vec<u8>,
}

#[wasm_bindgen]
impl RecordingPiece {
  /// Zero-based, in the order spoken.
  #[wasm_bindgen(getter)]
  pub fn index(&self) -> usize {
    self.index
  }

  /// Where the piece starts in the recording.
  #[wasm_bindgen(getter, js_name = startMs)]
  pub fn start_ms(&self) -> f64 {
    self.start_ms as f64
  }

  #[wasm_bindgen(getter, js_name = endMs)]
  pub fn end_ms(&self) -> f64 {
    self.end_ms as f64
  }

  /// The quiet between the previous piece's last word and this one's first.
  #[wasm_bindgen(getter, js_name = pauseBeforeMs)]
  pub fn pause_before_ms(&self) -> f64 {
    self.pause_before_ms as f64
  }

  /// Whether anything in the piece is loud enough to be speech; a silent
  /// piece is not worth a request.
  #[wasm_bindgen(getter)]
  pub fn speech(&self) -> bool {
    self.speech
  }

  /// The piece as 16 kHz mono 16-bit PCM WAV; taking it empties the piece.
  #[wasm_bindgen(js_name = takeWav)]
  pub fn take_wav(&mut self) -> Vec<u8> {
    std::mem::take(&mut self.wav)
  }
}

/// A recording opened for reading, handing out its pieces in order.
#[wasm_bindgen]
pub struct RecordingPieces {
  source: SymphoniaSource,
  cutter: Option<Pieces>,
  rate: u32,
  format: Format,
  ready: VecDeque<Piece>,
  block: Vec<f32>,
  decoded: u64,
  previous_trailing_ms: u64,
}

#[wasm_bindgen]
impl RecordingPieces {
  /// Opens the recording. `extension` (without the dot) tells apart
  /// containers whose first bytes say the same. Throws an error whose
  /// message is `unsupported`, `unreadable`, `too_long` or `dictaphone`.
  pub fn open(
    recording: RecordingBytes,
    extension: Option<String>,
  ) -> Result<RecordingPieces, JsError> {
    let head_end = recording.bytes.len().min(recording::HEAD_BYTES);
    let head = recording.bytes.get(..head_end).unwrap_or_default();
    let format = match recording::detect(head, extension.as_deref()) {
      Detected::Recording(format) if !format.needs_system_decoder() => format,
      Detected::Recording(_) | Detected::Refused(Refusal::Unknown) => {
        return Err(refused(refusal::UNSUPPORTED));
      }
      Detected::Refused(Refusal::Ds2 | Refusal::Dss) => {
        return Err(refused(refusal::DICTAPHONE));
      }
    };
    let stream = MediaSourceStream::new(
      Box::new(Cursor::new(recording.bytes)),
      MediaSourceStreamOptions::default(),
    );
    let source = SymphoniaSource::new(stream, extension.as_deref()).map_err(|error| {
      refused(match error {
        recording::DecodeError::Unsupported => refusal::UNSUPPORTED,
        recording::DecodeError::Unreadable | recording::DecodeError::Io(_) => {
          refusal::UNREADABLE
        }
      })
    })?;
    if source
      .duration_ms()
      .is_some_and(|duration| duration > recording::MAX_RECORDING_MS + DURATION_TOLERANCE_MS)
    {
      return Err(refused(refusal::TOO_LONG));
    }
    let rate = source.sample_rate();
    Ok(Self {
      source,
      cutter: Some(Pieces::new(rate, PieceRules::default())),
      rate,
      format,
      ready: VecDeque::new(),
      block: Vec::new(),
      decoded: 0,
      previous_trailing_ms: 0,
    })
  }

  /// The recording's length when its header says, in milliseconds.
  #[wasm_bindgen(getter, js_name = durationMs)]
  pub fn duration_ms(&self) -> Option<f64> {
    self.source.duration_ms().map(|duration| duration as f64)
  }

  /// The format's common name (`M4A`, `MP3`, ...).
  #[wasm_bindgen(getter)]
  pub fn format(&self) -> String {
    self.format.label().to_owned()
  }

  /// The next piece, or `undefined` once the recording ends. Throws
  /// `unreadable` or `too_long` as the decoder finds out.
  pub fn next(&mut self) -> Result<Option<RecordingPiece>, JsError> {
    loop {
      if let Some(piece) = self.ready.pop_front() {
        return Ok(Some(self.hand_on(piece)));
      }
      let Some(cutter) = self.cutter.as_mut() else {
        return Ok(None);
      };
      self.block.clear();
      let more = self
        .source
        .read(&mut self.block)
        .map_err(|_error| refused(refusal::UNREADABLE))?;
      self.decoded += self.block.len() as u64;
      if recording::millis(self.decoded, self.rate)
        > recording::MAX_RECORDING_MS + DURATION_TOLERANCE_MS
      {
        return Err(refused(refusal::TOO_LONG));
      }
      self.ready.extend(cutter.push(&self.block));
      if !more {
        if let Some(cutter) = self.cutter.take() {
          self.ready.extend(cutter.finish());
        }
      }
    }
  }
}

impl RecordingPieces {
  fn hand_on(&mut self, piece: Piece) -> RecordingPiece {
    let start_ms = recording::millis(piece.start, self.rate);
    let end_ms = recording::millis(piece.start + piece.samples.len() as u64, self.rate);
    let pause_before_ms = if piece.index == 0 {
      0
    } else {
      self.previous_trailing_ms + u64::from(piece.leading_quiet_ms)
    };
    self.previous_trailing_ms = u64::from(piece.trailing_quiet_ms);
    let samples = recording::resample(&piece.samples, self.rate, recording::PIECE_SAMPLE_RATE);
    RecordingPiece {
      index: piece.index,
      start_ms,
      end_ms,
      pause_before_ms,
      speech: piece.speech,
      wav: wav(&samples, recording::PIECE_SAMPLE_RATE),
    }
  }
}

/// `samples` as mono 16-bit PCM WAV, as the desktop sends a piece.
fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
  let data_bytes = u32::try_from(samples.len() * 2).unwrap_or(u32::MAX);
  let mut bytes = Vec::with_capacity(WAV_HEADER_BYTES + samples.len() * 2);
  bytes.extend_from_slice(b"RIFF");
  bytes.extend_from_slice(&(36_u32.saturating_add(data_bytes)).to_le_bytes());
  bytes.extend_from_slice(b"WAVEfmt ");
  bytes.extend_from_slice(&16_u32.to_le_bytes());
  bytes.extend_from_slice(&1_u16.to_le_bytes());
  bytes.extend_from_slice(&1_u16.to_le_bytes());
  bytes.extend_from_slice(&rate.to_le_bytes());
  bytes.extend_from_slice(&(rate * 2).to_le_bytes());
  bytes.extend_from_slice(&2_u16.to_le_bytes());
  bytes.extend_from_slice(&16_u16.to_le_bytes());
  bytes.extend_from_slice(b"data");
  bytes.extend_from_slice(&data_bytes.to_le_bytes());
  for sample in samples {
    // The clamped sample scaled to the i16 range fits by construction.
    let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
    bytes.extend_from_slice(&value.to_le_bytes());
  }
  bytes
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tone_wav(seconds: u32, rate: u32) -> Vec<u8> {
    let samples: Vec<f32> = (0..seconds * rate)
      .map(|index| {
        let second = index / rate;
        // Speech-loud for four seconds, then a second of silence.
        if second % 5 == 4 {
          0.0
        } else {
          (index as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5
        }
      })
      .collect();
    wav(&samples, rate)
  }

  fn pieces_of(bytes: Vec<u8>) -> Vec<RecordingPiece> {
    let mut recording = RecordingBytes::new(bytes.len());
    assert!(recording.write(0, &bytes));
    let Ok(mut pieces) = RecordingPieces::open(recording, Some("wav".to_owned())) else {
      panic!("a WAV recording opens");
    };
    let mut out = Vec::new();
    while let Ok(Some(piece)) = pieces.next() {
      out.push(piece);
    }
    out
  }

  #[test]
  fn cuts_a_recording_into_ordered_pieces_at_the_pieces_rate() {
    let pieces = pieces_of(tone_wav(120, 44_100));
    assert!(pieces.len() >= 3);
    for (index, piece) in pieces.iter().enumerate() {
      assert_eq!(piece.index, index);
      assert!(piece.end_ms - piece.start_ms <= 55_000);
      assert_eq!(&piece.wav[..4], b"RIFF");
      assert_eq!(u32::from_le_bytes([piece.wav[24], piece.wav[25], piece.wav[26], piece.wav[27]]), 16_000);
    }
    assert_eq!(pieces[0].start_ms, 0);
    assert!(pieces.windows(2).all(|pair| pair[0].end_ms == pair[1].start_ms));
    let last = pieces.last().map_or(0, |piece| piece.end_ms);
    assert!((119_900..=120_000).contains(&last));
  }

  #[test]
  fn writes_past_the_end_are_refused() {
    let mut recording = RecordingBytes::new(4);
    assert!(recording.write(0, b"RIFF"));
    assert!(!recording.write(2, b"RIFF"));
    assert!(!recording.write(usize::MAX, b"R"));
  }
}
