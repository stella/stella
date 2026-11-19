//! Decodes a recording's first audio track into one channel, block by block.

use std::{fmt, fs::File, path::Path};

use opus_decoder::OpusDecoder;
use symphonia::core::{
  codecs::{
    CodecParameters,
    audio::{
      AudioCodecParameters, AudioDecoder, AudioDecoderOptions,
      well_known::CODEC_ID_OPUS,
    },
  },
  errors::Error as SymphoniaError,
  formats::{FormatOptions, FormatReader, TrackType, probe::Hint},
  io::{MediaSourceStream, MediaSourceStreamOptions},
  meta::MetadataOptions,
};

/// Opus always decodes at one of its own rates; 16 kHz is the pieces' rate.
const OPUS_RATE: u32 = crate::PIECE_SAMPLE_RATE;
/// The longest Opus packet: 120 ms at 16 kHz.
const OPUS_MAX_FRAME: usize = 1_920;
/// A stream this damaged is not worth decoding on.
const MAX_SKIPPED_PACKETS: usize = 1_000;
/// The highest rate a recording may declare. Real recorders stop at 384 kHz;
/// a header claiming more is damaged, and resampling from it would allocate
/// a filter table far larger than the audio.
const MAX_SAMPLE_RATE: u32 = 384_000;

/// Why a recording could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
  /// The file holds no audio track this desktop decodes.
  Unsupported,
  /// The file is damaged or not what its header says.
  Unreadable,
  /// The file could not be opened or read.
  Io(String),
}

impl fmt::Display for DecodeError {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Unsupported => formatter.write_str("no supported audio track"),
      Self::Unreadable => formatter.write_str("the recording could not be decoded"),
      Self::Io(error) => write!(formatter, "the recording could not be read: {error}"),
    }
  }
}

impl std::error::Error for DecodeError {}

impl From<SymphoniaError> for DecodeError {
  fn from(error: SymphoniaError) -> Self {
    match error {
      SymphoniaError::IoError(error) => Self::Io(error.to_string()),
      SymphoniaError::Unsupported(_) => Self::Unsupported,
      _ => Self::Unreadable,
    }
  }
}

/// A recording decoded to one channel as it is read.
pub trait MonoSource {
  fn sample_rate(&self) -> u32;
  /// The recording's length, when its header says.
  fn duration_ms(&self) -> Option<u64>;
  /// Appends the next block of samples to `out`; `false` once the recording
  /// ends.
  fn read(&mut self, out: &mut Vec<f32>) -> Result<bool, DecodeError>;
}

/// The first audio track of a file Symphonia reads.
pub struct SymphoniaSource {
  reader: Box<dyn FormatReader>,
  track_id: u32,
  rate: u32,
  duration_ms: Option<u64>,
  codec: Codec,
  interleaved: Vec<f32>,
  skipped: usize,
}

enum Codec {
  Symphonia(Box<dyn AudioDecoder>),
  Opus(Box<OpusDecoder>, Vec<f32>),
}

/// Opens `path` for decoding. `extension` helps the probe where a container's
/// first bytes are ambiguous.
pub fn open(
  path: &Path,
  extension: Option<&str>,
) -> Result<SymphoniaSource, DecodeError> {
  let file = File::open(path).map_err(|error| DecodeError::Io(error.to_string()))?;
  SymphoniaSource::new(
    MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default()),
    extension,
  )
}

impl SymphoniaSource {
  pub fn new(
    stream: MediaSourceStream<'static>,
    extension: Option<&str>,
  ) -> Result<Self, DecodeError> {
    let mut hint = Hint::new();
    if let Some(extension) = extension {
      hint.with_extension(extension);
    }
    let reader = symphonia::default::get_probe().probe(
      &hint,
      stream,
      FormatOptions::default(),
      MetadataOptions::default(),
    )?;
    let track = reader
      .default_track(TrackType::Audio)
      .ok_or(DecodeError::Unsupported)?;
    let Some(CodecParameters::Audio(params)) = track.codec_params.as_ref() else {
      return Err(DecodeError::Unsupported);
    };
    let track_id = track.id;
    let duration_ms = track
      .time_base
      .zip(track.duration)
      .and_then(|(base, duration)| base.calc_duration(duration))
      .and_then(|time| u64::try_from((time.as_secs_f64() * 1_000.0) as i64).ok())
      .or_else(|| {
        let frames = track.num_frames?;
        let rate = params.sample_rate.filter(|rate| *rate > 0)?;
        Some(frames * 1_000 / u64::from(rate))
      });
    let (codec, rate) = if params.codec == CODEC_ID_OPUS {
      if !is_single_stream_opus(params) {
        // A multistream (surround) Opus recording needs its channel mapping,
        // which this decoder does not apply; refusing here lets the system
        // decoder try it instead.
        return Err(DecodeError::Unsupported);
      }
      let decoder =
        OpusDecoder::new(OPUS_RATE, 1).map_err(|_error| DecodeError::Unreadable)?;
      (
        Codec::Opus(Box::new(decoder), vec![0.0; OPUS_MAX_FRAME]),
        OPUS_RATE,
      )
    } else {
      let rate = params
        .sample_rate
        .filter(|rate| (1..=MAX_SAMPLE_RATE).contains(rate))
        .ok_or(DecodeError::Unsupported)?;
      let decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())?;
      (Codec::Symphonia(decoder), rate)
    };
    Ok(Self {
      reader,
      track_id,
      rate,
      duration_ms,
      codec,
      interleaved: Vec::new(),
      skipped: 0,
    })
  }

  /// A packet that does not decode is skipped, as players do; too many
  /// mean the file is not what it says.
  fn skip(&mut self) -> Result<(), DecodeError> {
    self.skipped += 1;
    if self.skipped > MAX_SKIPPED_PACKETS {
      return Err(DecodeError::Unreadable);
    }
    Ok(())
  }
}

/// Whether an Opus track is one elementary stream (mono or stereo), which
/// the decoder reads directly. The identification header (RFC 7845 §5.1)
/// gives the mapping family at byte 18 and, past family 0, the stream count
/// at byte 19; without it, more than two channels means several streams.
fn is_single_stream_opus(params: &AudioCodecParameters) -> bool {
  match params.extra_data.as_deref() {
    Some(head) if head.len() >= 19 => match head[18] {
      0 => true,
      _ => head.get(19) == Some(&1),
    },
    _ => params
      .channels
      .as_ref()
      .is_none_or(|channels| channels.count() <= 2),
  }
}

impl MonoSource for SymphoniaSource {
  fn sample_rate(&self) -> u32 {
    self.rate
  }

  fn duration_ms(&self) -> Option<u64> {
    self.duration_ms
  }

  fn read(&mut self, out: &mut Vec<f32>) -> Result<bool, DecodeError> {
    loop {
      let packet = match self.reader.next_packet() {
        Ok(Some(packet)) => packet,
        Ok(None) => return Ok(false),
        // A file cut short ends where it is cut.
        Err(SymphoniaError::IoError(error))
          if error.kind() == std::io::ErrorKind::UnexpectedEof =>
        {
          return Ok(false);
        }
        Err(error) => return Err(error.into()),
      };
      if packet.track_id != self.track_id {
        continue;
      }
      match &mut self.codec {
        Codec::Symphonia(decoder) => match decoder.decode(&packet) {
          Ok(decoded) => {
            let channels = decoded.spec().channels().count().max(1);
            decoded.copy_to_vec_interleaved(&mut self.interleaved);
            append_mono(&self.interleaved, channels, out);
            return Ok(true);
          }
          Err(SymphoniaError::DecodeError(_)) => self.skip()?,
          Err(SymphoniaError::ResetRequired) => decoder.reset(),
          Err(error) => return Err(error.into()),
        },
        Codec::Opus(decoder, pcm) => {
          match decoder.decode_float(&packet.data, pcm, false) {
            Ok(frames) => {
              out.extend_from_slice(&pcm[..frames.min(pcm.len())]);
              return Ok(true);
            }
            Err(_error) => self.skip()?,
          }
        }
      }
    }
  }
}

/// Averages interleaved frames into one channel.
fn append_mono(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
  if channels <= 1 {
    out.extend_from_slice(interleaved);
    return;
  }
  out.extend(
    interleaved
      .chunks_exact(channels)
      .map(|frame| frame.iter().sum::<f32>() / channels as f32),
  );
}

#[cfg(test)]
mod tests {
  use std::io::Cursor;

  use super::*;

  /// 16-bit PCM WAV of `channels` interleaved channels.
  fn wav(samples: &[f32], rate: u32, channels: u16) -> Vec<u8> {
    let data = u32::try_from(samples.len() * 2).unwrap();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&channels.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2 * u32::from(channels)).to_le_bytes());
    bytes.extend_from_slice(&(2 * channels).to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data.to_le_bytes());
    for sample in samples {
      let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
      bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
  }

  fn source(bytes: Vec<u8>) -> Result<SymphoniaSource, DecodeError> {
    SymphoniaSource::new(
      MediaSourceStream::new(
        Box::new(Cursor::new(bytes)),
        MediaSourceStreamOptions::default(),
      ),
      Some("wav"),
    )
  }

  fn read_all(mut source: SymphoniaSource) -> Vec<f32> {
    let mut out = Vec::new();
    while source.read(&mut out).unwrap() {}
    out
  }

  #[test]
  fn a_rate_past_any_recorder_is_refused() {
    let bytes = wav(&[0.0; 64], 1_000_000, 1);
    assert_eq!(source(bytes).err(), Some(DecodeError::Unsupported));
  }

  /// An Opus identification header with `family`, `channels` and `streams`.
  fn opus_head(family: u8, channels: u8, streams: u8) -> AudioCodecParameters {
    let mut head = b"OpusHead".to_vec();
    head.extend_from_slice(&[1, channels, 0, 0, 0x80, 0x3e, 0, 0, 0, 0, family]);
    if family != 0 {
      head.extend_from_slice(&[streams, 0]);
      head.extend(0..channels);
    }
    let mut params = AudioCodecParameters::new();
    params.with_extra_data(head.into_boxed_slice());
    params
  }

  #[test]
  fn only_single_stream_opus_goes_to_the_opus_decoder() {
    assert!(is_single_stream_opus(&opus_head(0, 2, 1)));
    assert!(is_single_stream_opus(&opus_head(1, 2, 1)));
    assert!(!is_single_stream_opus(&opus_head(1, 6, 4)));
    let mut surround = AudioCodecParameters::new();
    surround.with_channels(symphonia::core::audio::Channels::Discrete(6));
    assert!(!is_single_stream_opus(&surround));
    assert!(is_single_stream_opus(&AudioCodecParameters::new()));
  }

  #[test]
  fn a_stereo_wav_decodes_to_one_channel_with_its_length() {
    let frames = 44_100 * 2;
    let interleaved = (0..frames)
      .flat_map(|index| {
        let value = 0.25 * ((index as f32) * 0.01).sin();
        [value, value]
      })
      .collect::<Vec<_>>();
    let source = source(wav(&interleaved, 44_100, 2)).unwrap();
    assert_eq!(source.sample_rate(), 44_100);
    assert_eq!(source.duration_ms(), Some(2_000));
    let mono = read_all(source);
    assert_eq!(mono.len(), frames);
    let expected = 0.25 * (1_000.0_f32 * 0.01).sin();
    assert!((mono[1_000] - expected).abs() < 1e-3);
  }

  #[test]
  fn a_file_that_is_not_audio_is_refused() {
    assert!(source(b"%PDF-1.7 not audio at all".to_vec()).is_err());
  }

  #[test]
  fn a_wav_cut_short_ends_where_it_is_cut() {
    let mut bytes = wav(&vec![0.1; 16_000], 16_000, 1);
    bytes.truncate(bytes.len() / 2);
    let mono = read_all(source(bytes).unwrap());
    assert!(!mono.is_empty() && mono.len() < 16_000, "{}", mono.len());
  }
}
