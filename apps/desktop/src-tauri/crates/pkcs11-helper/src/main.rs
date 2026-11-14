//! `stella-pkcs11-helper`: one PKCS #11 request per process.
//!
//! stella desktop starts this process, writes one JSON request to stdin and
//! closes it, then reads one JSON response from stdout (see
//! [`stella_desktop_pkcs11::protocol`]). The vendor's module is loaded here,
//! never in the app: a module that crashes, hangs or misbehaves takes down
//! this process only, and the app kills it if it does not answer in time.
//!
//! Nothing is logged. The request may carry a PIN; its buffer is wiped once
//! the request is parsed, and the parsed PIN is wiped on drop.

mod context_sign;
mod failure;
mod readers;
mod token;

use std::io::{Read, Write};
use std::process::ExitCode;

use stella_desktop_pkcs11::protocol::{
  MAX_REQUEST_BYTES, Request, Response, decode_request, encode,
};
use stella_desktop_signing_core::SigningErrorCode;
use zeroize::Zeroizing;

fn main() -> ExitCode {
  let response = match read_request() {
    Ok(Request::List { modules }) => token::list(&modules),
    Ok(Request::Sign(request)) => token::sign(&request),
    Err(detail) => Response::failed(SigningErrorCode::SigningFailed, detail),
  };
  let Ok(encoded) = encode(&response) else {
    return ExitCode::FAILURE;
  };
  let mut stdout = std::io::stdout().lock();
  if stdout
    .write_all(&encoded)
    .and_then(|()| stdout.flush())
    .is_err()
  {
    return ExitCode::FAILURE;
  }
  ExitCode::SUCCESS
}

fn read_request() -> Result<Request, String> {
  // One byte past the limit tells an oversized request from one that fits.
  // Reserved up front, so reading never reallocates and leaves a copy of the
  // PIN behind in a freed buffer.
  let mut buffer = Zeroizing::new(Vec::with_capacity(MAX_REQUEST_BYTES + 1));
  let limit = u64::try_from(MAX_REQUEST_BYTES + 1).unwrap_or(u64::MAX);
  std::io::stdin()
    .lock()
    .take(limit)
    .read_to_end(&mut buffer)
    .map_err(|error| format!("the request could not be read: {error}"))?;
  decode_request(&buffer).map_err(|error| error.to_string())
}
