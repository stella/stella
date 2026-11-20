//! What kind of recording a file is, from its first bytes, with the file
//! name's extension only to tell apart containers whose bytes say the same
//! (an MP4 that is a voice memo or a video). A file is never read further
//! here; the decoders find out whether its contents hold up.

/// A recording this desktop transcribes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
  Wav,
  Aiff,
  Flac,
  Mp3,
  /// AAC in ADTS frames, as a `.aac` file.
  Aac,
  /// MPEG-4 audio: a voice memo or a music file.
  M4a,
  /// MPEG-4 video; its sound is transcribed.
  Mp4,
  /// QuickTime video; its sound is transcribed.
  Mov,
  /// 3GPP, as phones record voice messages: usually AMR inside.
  ThreeGp,
  Ogg,
  Opus,
  /// Matroska or WebM, as browsers record.
  Webm,
  Caf,
  Wma,
  Amr,
}

impl Format {
  /// The name people know the format by, as the window shows it.
  pub const fn label(self) -> &'static str {
    match self {
      Self::Wav => "WAV",
      Self::Aiff => "AIFF",
      Self::Flac => "FLAC",
      Self::Mp3 => "MP3",
      Self::Aac => "AAC",
      Self::M4a => "M4A",
      Self::Mp4 => "MP4",
      Self::Mov => "MOV",
      Self::ThreeGp => "3GP",
      Self::Ogg => "Ogg",
      Self::Opus => "Opus",
      Self::Webm => "WebM",
      Self::Caf => "CAF",
      Self::Wma => "WMA",
      Self::Amr => "AMR",
    }
  }

  /// Read only by the operating system's decoders: no pure-Rust decoder
  /// for the codec exists.
  pub const fn needs_system_decoder(self) -> bool {
    matches!(self, Self::Wma | Self::Amr)
  }
}

/// Why a file is not transcribed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
  /// Olympus and Philips DS2: an encrypted-capable codec with no decoder
  /// stella can ship. The recorder's software exports WAV.
  Ds2,
  /// Olympus and Philips DSS: its codec has only a copyleft decoder, which
  /// stella does not ship. The recorder's software exports WAV.
  Dss,
  /// Not a recording this desktop knows.
  Unknown,
}

/// The result of looking at a file's first bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detected {
  Recording(Format),
  Refused(Refusal),
}

/// How many leading bytes [`detect`] looks at; fewer are fine for a short
/// file.
pub const HEAD_BYTES: usize = 64;

const ASF_HEADER: [u8; 16] = [
  0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62,
  0xCE, 0x6C,
];
const EBML_HEADER: [u8; 4] = [0x1A, 0x45, 0xDF, 0xA3];

/// The format of a file whose first bytes are `head` and whose name ends in
/// `extension` (without the dot, any case).
pub fn detect(head: &[u8], extension: Option<&str>) -> Detected {
  let extension = extension.map(str::to_ascii_lowercase);
  let extension = extension.as_deref();
  if let Some(refused) = dictaphone(head, extension) {
    return Detected::Refused(refused);
  }
  match container(head, extension) {
    Some(format) => Detected::Recording(format),
    None => Detected::Refused(Refusal::Unknown),
  }
}

/// DSS starts with a version byte and `dss`, DS2 with one and `ds2`; a file
/// too short to say is judged by its name.
fn dictaphone(head: &[u8], extension: Option<&str>) -> Option<Refusal> {
  match head.get(1..4) {
    Some(b"ds2") => return Some(Refusal::Ds2),
    Some(b"dss") => return Some(Refusal::Dss),
    _ => {}
  }
  match extension {
    Some("ds2") => Some(Refusal::Ds2),
    Some("dss") => Some(Refusal::Dss),
    _ => None,
  }
}

fn container(head: &[u8], extension: Option<&str>) -> Option<Format> {
  let at =
    |offset: usize, magic: &[u8]| head.get(offset..offset + magic.len()) == Some(magic);
  if (at(0, b"RIFF") || at(0, b"RF64") || at(0, b"BW64")) && at(8, b"WAVE") {
    return Some(Format::Wav);
  }
  if at(0, b"FORM") && (at(8, b"AIFF") || at(8, b"AIFC")) {
    return Some(Format::Aiff);
  }
  if at(0, b"fLaC") {
    return Some(Format::Flac);
  }
  if at(0, b"OggS") {
    return Some(ogg(head));
  }
  if at(0, b"caff") {
    return Some(Format::Caf);
  }
  if at(0, &ASF_HEADER) {
    return Some(Format::Wma);
  }
  if at(0, b"#!AMR") {
    return Some(Format::Amr);
  }
  if at(0, &EBML_HEADER) {
    return Some(Format::Webm);
  }
  if at(4, b"ftyp") {
    return Some(iso_brand(head.get(8..12), extension));
  }
  // An older QuickTime file opens with its movie or data atom.
  if ["moov", "mdat", "wide", "free", "skip"]
    .iter()
    .any(|atom| at(4, atom.as_bytes()))
  {
    return Some(match extension {
      Some("mp4" | "m4v") => Format::Mp4,
      Some("m4a") => Format::M4a,
      _ => Format::Mov,
    });
  }
  if at(0, b"ID3") {
    // A tag says nothing of what follows; the name does.
    return Some(match extension {
      Some("aac") => Format::Aac,
      Some("flac") => Format::Flac,
      _ => Format::Mp3,
    });
  }
  mpeg_audio(head)
}

/// Opus and Vorbis share the Ogg container; the first packet names the codec.
fn ogg(head: &[u8]) -> Format {
  let first_packet = head.get(28..36);
  if first_packet == Some(b"OpusHead") {
    Format::Opus
  } else if head.get(28..33) == Some(b"\x7fFLAC") {
    Format::Flac
  } else {
    Format::Ogg
  }
}

fn iso_brand(brand: Option<&[u8]>, extension: Option<&str>) -> Format {
  match brand {
    Some(b"qt  ") => Format::Mov,
    Some(b"M4A " | b"M4B " | b"M4P ") => Format::M4a,
    Some(brand) if brand.starts_with(b"3g") => Format::ThreeGp,
    _ => match extension {
      Some("m4a" | "m4b") => Format::M4a,
      Some("mov") => Format::Mov,
      Some("3gp" | "3g2") => Format::ThreeGp,
      _ => Format::Mp4,
    },
  }
}

/// A bare MPEG audio frame: twelve sync bits, then the layer bits tell MP3
/// (layer III, as MP1 and MP2 decode the same way) from AAC in ADTS (layer
/// bits zero).
fn mpeg_audio(head: &[u8]) -> Option<Format> {
  let (&first, &second) = (head.first()?, head.get(1)?);
  if first != 0xFF || second & 0xE0 != 0xE0 {
    return None;
  }
  let layer = (second >> 1) & 0b11;
  if second & 0xF0 == 0xF0 && layer == 0 {
    Some(Format::Aac)
  } else if layer != 0 {
    Some(Format::Mp3)
  } else {
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn padded(prefix: &[u8]) -> Vec<u8> {
    let mut head = prefix.to_vec();
    head.resize(HEAD_BYTES, 0);
    head
  }

  fn recording(head: &[u8], extension: Option<&str>) -> Format {
    match detect(head, extension) {
      Detected::Recording(format) => format,
      Detected::Refused(refusal) => panic!("refused as {refusal:?}"),
    }
  }

  #[test]
  fn dictaphone_files_are_refused_by_their_bytes_whatever_their_name() {
    assert_eq!(
      detect(&padded(b"\x03ds2"), Some("wav")),
      Detected::Refused(Refusal::Ds2)
    );
    assert_eq!(
      detect(&padded(b"\x02dss"), None),
      Detected::Refused(Refusal::Dss)
    );
    assert_eq!(
      detect(&padded(b"\x03dss"), Some("DSS")),
      Detected::Refused(Refusal::Dss)
    );
    // A file too short to carry the header is judged by its name.
    assert_eq!(detect(b"", Some("DS2")), Detected::Refused(Refusal::Ds2));
  }

  #[test]
  fn riff_and_iff_containers_are_told_apart_by_their_form_type() {
    assert_eq!(
      recording(&padded(b"RIFF\0\0\0\0WAVEfmt "), None),
      Format::Wav
    );
    assert_eq!(recording(&padded(b"RF64\0\0\0\0WAVE"), None), Format::Wav);
    assert_eq!(recording(&padded(b"FORM\0\0\0\0AIFF"), None), Format::Aiff);
    assert_eq!(recording(&padded(b"FORM\0\0\0\0AIFC"), None), Format::Aiff);
    // A RIFF file of another kind is not a recording.
    assert_eq!(
      detect(&padded(b"RIFF\0\0\0\0AVI "), Some("wav")),
      Detected::Refused(Refusal::Unknown)
    );
  }

  #[test]
  fn ogg_names_its_codec_in_the_first_packet() {
    let mut opus = padded(b"OggS");
    opus[28..36].copy_from_slice(b"OpusHead");
    assert_eq!(recording(&opus, Some("ogg")), Format::Opus);
    let mut vorbis = padded(b"OggS");
    vorbis[28..35].copy_from_slice(b"\x01vorbis");
    assert_eq!(recording(&vorbis, Some("opus")), Format::Ogg);
    let mut flac = padded(b"OggS");
    flac[28..33].copy_from_slice(b"\x7fFLAC");
    assert_eq!(recording(&flac, None), Format::Flac);
  }

  #[test]
  fn iso_files_are_audio_or_video_by_brand_then_by_name() {
    let iso = |brand: &[u8]| {
      let mut head = padded(b"\0\0\0\x20ftyp");
      head[8..12].copy_from_slice(brand);
      head
    };
    assert_eq!(recording(&iso(b"M4A "), Some("mp4")), Format::M4a);
    assert_eq!(recording(&iso(b"qt  "), None), Format::Mov);
    assert_eq!(recording(&iso(b"3gp4"), None), Format::ThreeGp);
    assert_eq!(recording(&iso(b"isom"), Some("m4a")), Format::M4a);
    assert_eq!(recording(&iso(b"isom"), Some("MOV")), Format::Mov);
    assert_eq!(recording(&iso(b"mp42"), Some("mp4")), Format::Mp4);
    assert_eq!(recording(&iso(b"mp42"), None), Format::Mp4);
    assert_eq!(recording(&padded(b"\0\0\0\x08wide"), None), Format::Mov);
  }

  #[test]
  fn mpeg_frames_tell_mp3_from_adts_aac() {
    assert_eq!(recording(&padded(&[0xFF, 0xFB, 0x90]), None), Format::Mp3);
    assert_eq!(recording(&padded(&[0xFF, 0xF3, 0x90]), None), Format::Mp3);
    assert_eq!(recording(&padded(&[0xFF, 0xF1, 0x50]), None), Format::Aac);
    assert_eq!(recording(&padded(&[0xFF, 0xF9, 0x50]), None), Format::Aac);
    assert_eq!(recording(&padded(b"ID3\x04"), None), Format::Mp3);
    assert_eq!(recording(&padded(b"ID3\x04"), Some("aac")), Format::Aac);
    assert_eq!(
      detect(&padded(&[0xFF, 0x00]), Some("mp3")),
      Detected::Refused(Refusal::Unknown)
    );
  }

  #[test]
  fn system_decoded_formats_are_named_by_their_headers() {
    let mut asf = ASF_HEADER.to_vec();
    asf.resize(HEAD_BYTES, 0);
    assert_eq!(recording(&asf, Some("wma")), Format::Wma);
    assert_eq!(recording(&padded(b"#!AMR\n"), None), Format::Amr);
    assert_eq!(recording(&padded(b"#!AMR-WB\n"), None), Format::Amr);
    assert!(Format::Wma.needs_system_decoder());
    assert!(Format::Amr.needs_system_decoder());
    assert!(!Format::Mp4.needs_system_decoder());
  }

  #[test]
  fn other_files_are_not_recordings() {
    for head in [&b"%PDF-1.7"[..], b"PK\x03\x04", b"", b"hello world"] {
      assert_eq!(
        detect(&padded(head), Some("mp3")),
        Detected::Refused(Refusal::Unknown),
        "{head:?}"
      );
    }
    assert_eq!(recording(&padded(&EBML_HEADER), None), Format::Webm);
    assert_eq!(recording(&padded(b"caff"), None), Format::Caf);
    assert_eq!(recording(&padded(b"fLaC"), None), Format::Flac);
  }
}
