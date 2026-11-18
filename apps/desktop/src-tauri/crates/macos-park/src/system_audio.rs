//! Decodes a recording with AVFoundation, for the codecs no pure-Rust
//! decoder reads (AMR, HE-AAC and the like). Samples come out as one
//! channel of 32-bit floats; native buffers never leave this module.

use std::path::Path;

use objc2::{AnyThread, rc::Retained};
use objc2_avf_audio::{AVAudioCommonFormat, AVAudioFile, AVAudioPCMBuffer};
use objc2_foundation::NSURL;

use crate::SystemAudioError;

/// Frames decoded per read: about a second at common rates.
const BLOCK_FRAMES: u32 = 32_768;

/// A recording open for reading through AVFoundation.
pub struct SystemAudioReader {
  file: Retained<AVAudioFile>,
  buffer: Retained<AVAudioPCMBuffer>,
  channels: usize,
  rate: u32,
  duration_ms: Option<u64>,
}

impl SystemAudioReader {
  pub fn open(path: &Path) -> Result<Self, SystemAudioError> {
    let url = NSURL::from_file_path(path).ok_or(SystemAudioError::Unreadable)?;
    // SAFETY: `url` is a live file URL; the initializer reports a file it
    // cannot read as an error, never as a null object.
    let file = unsafe {
      AVAudioFile::initForReading_commonFormat_interleaved_error(
        AVAudioFile::alloc(),
        &url,
        AVAudioCommonFormat::PCMFormatFloat32,
        false,
      )
    }
    .map_err(|_error| SystemAudioError::Unsupported)?;
    // SAFETY: `file` is open; these read its processing format and length.
    let (format, length) = unsafe { (file.processingFormat(), file.length()) };
    // SAFETY: `format` is the live processing format read above.
    let (channels, rate) = unsafe { (format.channelCount(), format.sampleRate()) };
    let channels =
      usize::try_from(channels).map_err(|_error| SystemAudioError::Unreadable)?;
    if channels == 0 || !rate.is_finite() || rate < 1.0 || rate > 768_000.0 {
      return Err(SystemAudioError::Unreadable);
    }
    let rate = rate.round() as u32;
    // SAFETY: the buffer takes the file's own processing format, which is
    // what `readIntoBuffer` requires; a capacity it cannot hold is `None`.
    let buffer = unsafe {
      AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
        AVAudioPCMBuffer::alloc(),
        &format,
        BLOCK_FRAMES,
      )
    }
    .ok_or(SystemAudioError::Unreadable)?;
    let duration_ms = u64::try_from(length)
      .ok()
      .filter(|frames| *frames > 0)
      .map(|frames| frames.saturating_mul(1_000) / u64::from(rate));
    Ok(Self {
      file,
      buffer,
      channels,
      rate,
      duration_ms,
    })
  }

  pub const fn sample_rate(&self) -> u32 {
    self.rate
  }

  pub const fn duration_ms(&self) -> Option<u64> {
    self.duration_ms
  }

  /// Appends the next block, averaged to one channel; `false` at the end.
  pub fn read_mono(&mut self, out: &mut Vec<f32>) -> Result<bool, SystemAudioError> {
    // SAFETY: reads the open file's position and length. A read at the end
    // is an error to AVFoundation, so the end is found here first.
    if unsafe { self.file.framePosition() >= self.file.length() } {
      return Ok(false);
    }
    // SAFETY: the buffer was made with the file's processing format.
    if unsafe { self.file.readIntoBuffer_error(&self.buffer) }.is_err() {
      // A compressed file's length is an estimate (an AMR file's runs a few
      // packets long), so a read that fails in its last stretch is its end.
      // SAFETY: reads the open file's position and length.
      let (position, length) =
        unsafe { (self.file.framePosition(), self.file.length()) };
      let slack = (length / 20).max(i64::from(self.rate));
      if position > 0 && length - position <= slack {
        return Ok(false);
      }
      return Err(SystemAudioError::Unreadable);
    }
    // SAFETY: reads the count of valid frames the read just set.
    let frames = unsafe { self.buffer.frameLength() } as usize;
    if frames == 0 {
      return Ok(false);
    }
    // SAFETY: the processing format is deinterleaved 32-bit float, so
    // `floatChannelData` holds `channels` non-null pointers, each to at
    // least `frameLength` valid samples that live as long as the buffer,
    // which `self` borrows for the whole copy below.
    let planes = unsafe { self.buffer.floatChannelData() };
    if planes.is_null() {
      return Err(SystemAudioError::Unreadable);
    }
    let start = out.len();
    out.resize(start + frames, 0.0);
    let mixed = &mut out[start..];
    for channel in 0..self.channels {
      // SAFETY: `channel` is below the format's channel count (see above).
      let plane = unsafe { *planes.add(channel) };
      // SAFETY: the plane holds `frames` initialized floats (see above).
      let samples = unsafe { std::slice::from_raw_parts(plane.as_ptr(), frames) };
      for (target, sample) in mixed.iter_mut().zip(samples) {
        *target += *sample;
      }
    }
    if self.channels > 1 {
      let scale = 1.0 / self.channels as f32;
      for sample in mixed {
        *sample *= scale;
      }
    }
    Ok(true)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A quarter second of an 8 kHz tone on the left channel, silence on the
  /// right, as 16-bit stereo WAV.
  fn fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/stereo-tone.wav")
  }

  #[test]
  fn a_stereo_file_decodes_to_one_channel_at_its_rate() {
    let mut reader = SystemAudioReader::open(&fixture()).unwrap();
    assert_eq!(reader.sample_rate(), 8_000);
    assert_eq!(reader.duration_ms(), Some(250));
    let mut mono = Vec::new();
    while reader.read_mono(&mut mono).unwrap() {}
    assert_eq!(mono.len(), 2_000);
    // The silent right channel halves the left in the mix.
    let expected = 8_000.0 / 32_768.0 * (100.0_f32 * 0.05).sin() / 2.0;
    assert!(
      (mono[100] - expected).abs() < 1e-3,
      "{} vs {expected}",
      mono[100]
    );
  }

  #[test]
  fn a_file_that_is_not_audio_is_refused() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    assert!(SystemAudioReader::open(&path).is_err());
  }
}
