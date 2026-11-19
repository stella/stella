//! A recording on disk, read the way a transcription takes it: what format
//! it is, decoded to one channel, resampled to the speech models' 16 kHz and
//! cut into pieces short enough for one request, at pauses where the speaker
//! leaves them.
//!
//! Everything here is pure Rust and holds only the piece being cut, so a
//! four-hour file never sits in memory whole. Formats the pure-Rust decoders
//! do not read (WMA, AMR) are decoded by the operating system; the desktop
//! crate feeds those samples through the same [`MonoSource`] trait.

mod decode;
mod format;
mod pieces;
mod resample;

pub use decode::{DecodeError, MonoSource, SymphoniaSource, open};
pub use format::{Detected, Format, HEAD_BYTES, Refusal, detect};
pub use pieces::{Piece, PieceRules, Pieces};
pub use resample::resample;

/// The longest recording a transcription accepts.
pub const MAX_RECORDING_MS: u64 = 4 * 60 * 60 * 1_000;

/// The rate every piece is handed out at: what the API and the speech model
/// on this computer read.
pub const PIECE_SAMPLE_RATE: u32 = 16_000;

/// Milliseconds of `samples` at `rate`.
pub const fn millis(samples: u64, rate: u32) -> u64 {
  samples * 1_000 / rate as u64
}
