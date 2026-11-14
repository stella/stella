//! `C_Sign` on its own, for a key marked `CKA_ALWAYS_AUTHENTICATE`.
//!
//! Such a key (a qualified signature key, as on many national ID cards)
//! wants the PIN again for each signature, as a context-specific login
//! between `C_SignInit` and `C_Sign`. The released `cryptoki` offers
//! `C_SignInit` and `C_Sign` only as one call, so this module calls `C_Sign`
//! itself, through the module's own function list, on the session `cryptoki`
//! opened and initialised the operation on.
#![allow(
  unsafe_code,
  reason = "C_Sign through the module's function list; each block states why it is sound"
)]

use std::path::Path;
use std::ptr;

use cryptoki::context::Function;
use cryptoki::error::{Error, Rv};
use cryptoki_sys::{CK_FUNCTION_LIST, CK_SESSION_HANDLE, CK_ULONG};

/// The module's function list, reached through a second handle to the same
/// loaded library.
pub(crate) struct FunctionList {
  /// Keeps the library loaded for as long as `list` is used.
  _library: cryptoki_sys::Pkcs11,
  list: *mut CK_FUNCTION_LIST,
}

impl FunctionList {
  pub(crate) fn open(module: &Path) -> Result<Self, Error> {
    // SAFETY: `cryptoki` loaded and initialised this module already; loading
    // it again hands back the image already in the process (its
    // initialisers do not run twice) with one more reference.
    let library =
      unsafe { cryptoki_sys::Pkcs11::new(module) }.map_err(Error::LibraryLoading)?;
    let mut list = ptr::null_mut();
    if library.C_GetFunctionList.is_err() {
      return Err(Error::MissingSymbol("C_GetFunctionList"));
    }
    // SAFETY: `C_GetFunctionList` is resolved (checked above) and writes a
    // pointer to the module's static function table into `list`.
    Rv::from(unsafe { library.C_GetFunctionList(&raw mut list) })
      .into_result(Function::GetFunctionList)?;
    if list.is_null() {
      return Err(Error::NullFunctionPointer);
    }
    Ok(Self {
      _library: library,
      list,
    })
  }

  /// `C_Sign` for the operation `C_SignInit` started on `session`: the
  /// length first, then the signature.
  pub(crate) fn sign(
    &self,
    session: CK_SESSION_HANDLE,
    data: &[u8],
  ) -> Result<Vec<u8>, Error> {
    // SAFETY: `list` points to the module's static function table, which
    // lives as long as the library `_library` keeps loaded.
    let Some(c_sign) = (unsafe { (*self.list).C_Sign }) else {
      return Err(Error::NullFunctionPointer);
    };
    let data_len = CK_ULONG::try_from(data.len())?;
    let mut signature_len: CK_ULONG = 0;
    // SAFETY: `data` is valid for `data_len` bytes and only read; a null
    // output buffer asks for the length, written to `signature_len`.
    Rv::from(unsafe {
      c_sign(
        session,
        data.as_ptr().cast_mut(),
        data_len,
        ptr::null_mut(),
        &raw mut signature_len,
      )
    })
    .into_result(Function::Sign)?;
    let mut signature = vec![0; usize::try_from(signature_len)?];
    // SAFETY: `signature` has room for `signature_len` bytes, the length the
    // module asked for; it writes the length it used back.
    Rv::from(unsafe {
      c_sign(
        session,
        data.as_ptr().cast_mut(),
        data_len,
        signature.as_mut_ptr(),
        &raw mut signature_len,
      )
    })
    .into_result(Function::Sign)?;
    signature.truncate(usize::try_from(signature_len)?);
    Ok(signature)
  }
}
