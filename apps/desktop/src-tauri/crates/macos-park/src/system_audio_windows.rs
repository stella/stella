//! Decodes a recording with Media Foundation, for the codecs no pure-Rust
//! decoder reads (WMA, AMR and the like). The source reader converts to
//! 32-bit float itself; samples come out as one channel. COM objects and
//! locked buffers never leave this module.

use std::path::Path;

use windows::{
  Win32::{
    Media::MediaFoundation::{
      IMFSample, IMFSourceReader, MF_MT_AUDIO_NUM_CHANNELS,
      MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_PD_DURATION,
      MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
      MF_SOURCE_READER_MEDIASOURCE, MF_SOURCE_READERF_ENDOFSTREAM, MF_VERSION,
      MFAudioFormat_Float, MFCreateMediaType, MFCreateSourceReaderFromURL,
      MFMediaType_Audio, MFSTARTUP_LITE, MFShutdown, MFStartup,
    },
    System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
  },
  core::HSTRING,
};

use crate::SystemAudioError;

// The source reader takes stream indices as `u32`; these constants are the
// documented negative sentinels reinterpreted.
const FIRST_AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
const ALL_STREAMS: u32 = MF_SOURCE_READER_ALL_STREAMS.0 as u32;
const MEDIA_SOURCE: u32 = MF_SOURCE_READER_MEDIASOURCE.0 as u32;
const END_OF_STREAM: u32 = MF_SOURCE_READERF_ENDOFSTREAM.0 as u32;

/// COM and Media Foundation for the reader's lifetime, released in reverse
/// order. A thread COM already initialized differently keeps its own state.
struct Session {
  uninitialize_com: bool,
}

impl Session {
  fn start() -> Result<Self, SystemAudioError> {
    // SAFETY: initializes COM for this thread; balanced in `drop` only when
    // this call succeeded.
    let uninitialize_com =
      unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    // SAFETY: starts Media Foundation; balanced by `MFShutdown` in `drop`.
    if unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) }.is_err() {
      if uninitialize_com {
        // SAFETY: balances the successful initialization above.
        unsafe { CoUninitialize() };
      }
      return Err(SystemAudioError::Unsupported);
    }
    Ok(Self { uninitialize_com })
  }
}

impl Drop for Session {
  fn drop(&mut self) {
    // SAFETY: balances the `MFStartup` in `start`; the reader holding Media
    // Foundation objects is dropped before its session (field order).
    // A failed stop leaves nothing to recover.
    unsafe { MFShutdown() }.unwrap_or_default();
    if self.uninitialize_com {
      // SAFETY: balances the successful `CoInitializeEx` in `start`.
      unsafe { CoUninitialize() };
    }
  }
}

/// A recording open for reading through Media Foundation.
pub struct SystemAudioReader {
  // Dropped before `_session`, which shuts Media Foundation down.
  reader: IMFSourceReader,
  channels: usize,
  rate: u32,
  duration_ms: Option<u64>,
  _session: Session,
}

impl SystemAudioReader {
  pub fn open(path: &Path) -> Result<Self, SystemAudioError> {
    let session = Session::start()?;
    let url = HSTRING::from(path.as_os_str());
    // SAFETY: `url` is a NUL-terminated path that outlives the call; no
    // attributes are passed.
    let reader = unsafe { MFCreateSourceReaderFromURL(&url, None) }
      .map_err(|_error| SystemAudioError::Unsupported)?;
    // SAFETY: `reader` is live; the calls take plain values and a media type
    // this function owns.
    let (channels, rate) = unsafe {
      reader
        .SetStreamSelection(ALL_STREAMS, false)
        .and_then(|()| reader.SetStreamSelection(FIRST_AUDIO, true))
        .map_err(|_error| SystemAudioError::Unsupported)?;
      let float =
        MFCreateMediaType().map_err(|_error| SystemAudioError::Unsupported)?;
      float
        .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
        .and_then(|()| float.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float))
        .and_then(|()| reader.SetCurrentMediaType(FIRST_AUDIO, None, &float))
        .map_err(|_error| SystemAudioError::Unsupported)?;
      let current = reader
        .GetCurrentMediaType(FIRST_AUDIO)
        .map_err(|_error| SystemAudioError::Unreadable)?;
      let channels = current
        .GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)
        .map_err(|_error| SystemAudioError::Unreadable)?;
      let rate = current
        .GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)
        .map_err(|_error| SystemAudioError::Unreadable)?;
      (channels, rate)
    };
    let channels =
      usize::try_from(channels).map_err(|_error| SystemAudioError::Unreadable)?;
    if channels == 0 || rate == 0 {
      return Err(SystemAudioError::Unreadable);
    }
    // SAFETY: `reader` is live; the attribute is read into an owned value.
    let duration_ms =
      unsafe { reader.GetPresentationAttribute(MEDIA_SOURCE, &MF_PD_DURATION) }
        .ok()
        .and_then(|value| u64::try_from(&value).ok())
        // Media Foundation counts in 100-nanosecond units.
        .map(|hundreds_of_nanos| hundreds_of_nanos / 10_000)
        .filter(|millis| *millis > 0);
    Ok(Self {
      reader,
      channels,
      rate,
      duration_ms,
      _session: session,
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
    let mut flags = 0_u32;
    let mut sample: Option<IMFSample> = None;
    // SAFETY: `flags` and `sample` are live locals the call writes into.
    unsafe {
      self.reader.ReadSample(
        FIRST_AUDIO,
        0,
        None,
        Some(&raw mut flags),
        None,
        Some(&raw mut sample),
      )
    }
    .map_err(|_error| SystemAudioError::Unreadable)?;
    let Some(sample) = sample else {
      // A gap or a format change without data; the end says so by flag.
      return Ok(flags & END_OF_STREAM == 0);
    };
    // SAFETY: `sample` is a live sample the reader returned.
    let buffer = unsafe { sample.ConvertToContiguousBuffer() }
      .map_err(|_error| SystemAudioError::Unreadable)?;
    let mut data = std::ptr::null_mut::<u8>();
    let mut length = 0_u32;
    // SAFETY: `data` and `length` are live locals; the buffer stays locked
    // until the `Unlock` below, and nothing is read past `length` bytes.
    unsafe { buffer.Lock(&raw mut data, None, Some(&raw mut length)) }
      .map_err(|_error| SystemAudioError::Unreadable)?;
    if !data.is_null() {
      // SAFETY: while locked, `data` points at `length` readable bytes.
      let bytes = unsafe { std::slice::from_raw_parts(data, length as usize) };
      let (encoded, _) = bytes.as_chunks::<{ size_of::<f32>() }>();
      let samples = encoded
        .iter()
        .map(|sample| f32::from_le_bytes(*sample))
        .collect::<Vec<_>>();
      out.extend(
        samples
          .chunks_exact(self.channels)
          .map(|frame| frame.iter().sum::<f32>() / self.channels as f32),
      );
    }
    // SAFETY: balances the successful `Lock` above.
    unsafe { buffer.Unlock() }.map_err(|_error| SystemAudioError::Unreadable)?;
    Ok(flags & END_OF_STREAM == 0)
  }
}
