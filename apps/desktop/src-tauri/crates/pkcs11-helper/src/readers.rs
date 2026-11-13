//! The cards in the computer's readers, read through PC/SC without
//! connecting to them.
//!
//! A reader's status carries the ATR of the card in it. Reading the status
//! does not open a session with the card, so it neither disturbs another
//! application using the card nor needs its driver.

use stella_desktop_pkcs11::protocol::ReaderCard;

/// Every reader that holds a card, with the card's ATR. No reader at all is
/// an empty list; PC/SC refusing to answer is an error.
#[cfg(target_os = "macos")]
pub(crate) fn cards_in_readers() -> Result<Vec<ReaderCard>, String> {
  read_cards().map_err(|error| error.to_string())
}

/// The helper ships on macOS only; elsewhere nothing reads the readers.
#[cfg(not(target_os = "macos"))]
pub(crate) fn cards_in_readers() -> Result<Vec<ReaderCard>, String> {
  Err("reader status is read on macOS only".to_string())
}

#[cfg(target_os = "macos")]
fn read_cards() -> Result<Vec<ReaderCard>, pcsc::Error> {
  use std::time::Duration;

  use pcsc::{Context, ReaderState, Scope, State};

  let context = Context::establish(Scope::User)?;
  let readers = match context.list_readers_owned() {
    Ok(readers) => readers,
    Err(pcsc::Error::NoReadersAvailable) => return Ok(Vec::new()),
    Err(error) => return Err(error),
  };
  let mut states: Vec<ReaderState> = readers
    .into_iter()
    .map(|reader| ReaderState::new(reader, State::UNAWARE))
    .collect();
  if states.is_empty() {
    return Ok(Vec::new());
  }
  // With every reader UNAWARE the call answers at once with each one's
  // current state.
  context.get_status_change(Duration::ZERO, &mut states)?;
  Ok(
    states
      .iter()
      .filter(|state| state.event_state().contains(State::PRESENT))
      .map(|state| ReaderCard {
        reader: state.name().to_string_lossy().into_owned(),
        atr_hex: hex::encode(state.atr()),
      })
      .collect(),
  )
}
