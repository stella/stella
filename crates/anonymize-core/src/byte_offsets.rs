use crate::types::{Error, Result};

pub(crate) struct ByteOffsets<'a> {
  text: &'a str,
}

impl<'a> ByteOffsets<'a> {
  pub(crate) const fn new(text: &'a str) -> Self {
    Self { text }
  }

  pub(crate) fn len(&self) -> Result<u32> {
    u32::try_from(self.text.len())
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })
  }

  pub(crate) fn validate_offset(&self, offset: u32) -> Result<usize> {
    let index = usize::try_from(offset)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset })?;
    if index > self.text.len() {
      return Err(Error::ByteOffsetOutOfBounds { offset });
    }
    if !self.text.is_char_boundary(index) {
      return Err(Error::ByteOffsetInsideCodepoint { offset });
    }
    Ok(index)
  }

  pub(crate) fn floor_offset(&self, offset: u32) -> Result<u32> {
    let mut index = usize::try_from(offset)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset })?;
    if index > self.text.len() {
      index = self.text.len();
    }
    while index > 0 && !self.text.is_char_boundary(index) {
      index = index.saturating_sub(1);
    }
    u32::try_from(index)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })
  }

  pub(crate) fn slice(&self, start: u32, end: u32) -> Result<String> {
    Ok(self.slice_ref(start, end)?.to_owned())
  }

  pub(crate) fn slice_ref(&self, start: u32, end: u32) -> Result<&'a str> {
    if start > end {
      return Err(Error::InvalidSpan { start, end });
    }

    let start_byte = self.validate_offset(start)?;
    let end_byte = self.validate_offset(end)?;

    self
      .text
      .get(start_byte..end_byte)
      .ok_or(Error::InvalidSpan { start, end })
  }

  pub(crate) fn utf16_units_between(
    &self,
    start: u32,
    end: u32,
  ) -> Result<u32> {
    if start > end {
      return Err(Error::InvalidSpan { start, end });
    }

    let start_byte = self.validate_offset(start)?;
    let end_byte = self.validate_offset(end)?;
    let units = self
      .text
      .get(start_byte..end_byte)
      .ok_or(Error::InvalidSpan { start, end })?
      .chars()
      .map(char::len_utf16)
      .sum::<usize>();
    u32::try_from(units)
      .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })
  }

  pub(crate) fn offset_after_utf16_units(
    &self,
    start: u32,
    max_units: u32,
  ) -> Result<u32> {
    let start_byte = self.validate_offset(start)?;
    let mut units = 0_u32;
    let tail = self.text.get(start_byte..).ok_or(Error::InvalidSpan {
      start,
      end: self.len()?,
    })?;
    for (relative, ch) in tail.char_indices() {
      let width = u32::try_from(ch.len_utf16()).unwrap_or(u32::MAX);
      if units.saturating_add(width) > max_units {
        let offset = start_byte.saturating_add(relative);
        return u32::try_from(offset)
          .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX });
      }
      units = units.saturating_add(width);
    }
    self.len()
  }

  pub(crate) fn offset_before_utf16_units(
    &self,
    end: u32,
    max_units: u32,
  ) -> Result<u32> {
    let end_byte = self.validate_offset(end)?;
    let prefix = self
      .text
      .get(..end_byte)
      .ok_or(Error::InvalidSpan { start: 0, end })?;
    let mut units = 0_u32;
    for (byte, ch) in prefix.char_indices().rev() {
      let width = u32::try_from(ch.len_utf16()).unwrap_or(u32::MAX);
      if units.saturating_add(width) > max_units {
        let offset = byte.saturating_add(ch.len_utf8());
        return u32::try_from(offset)
          .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX });
      }
      units = units.saturating_add(width);
    }
    Ok(0)
  }
}
