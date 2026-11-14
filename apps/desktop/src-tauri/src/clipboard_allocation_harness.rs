//! The native pasteboard boundary consumes the same owned contents as production.
use super::*;

pub fn write(plain_text: String) {
  let expected_len = plain_text.len();
  publish_plain_text(plain_text, |contents| {
    assert!(matches!(contents.as_slice(), [ClipboardContent::Text(text)] if text.len() == expected_len));
    std::hint::black_box(&contents);
    Ok(())
  })
  .unwrap();
}
