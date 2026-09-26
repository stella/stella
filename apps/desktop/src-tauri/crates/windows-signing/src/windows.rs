//! The CryptoAPI and CNG half. Everything here blocks on the certificate
//! store or a key storage provider and must run off the async runtime.
//!
//! Every raw handle is owned by exactly one wrapper whose `Drop` releases it,
//! so no early return can leak a store, a certificate context or a key.

use std::ffi::c_void;
use std::ptr;

use stella_desktop_signing_core::{
  SigningError, SigningErrorCode, SigningIdentity, SigningKeyType,
  certificate_fingerprint, ecdsa_signature_der, signing_identity, unix_now,
};
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, GetLastError};
use windows_sys::Win32::Security::Cryptography::{
  BCRYPT_PKCS1_PADDING_INFO, BCRYPT_SHA256_ALGORITHM,
  CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL, CERT_CHAIN_CONTEXT,
  CERT_CHAIN_DISABLE_AUTH_ROOT_AUTO_UPDATE, CERT_CHAIN_PARA, CERT_CONTEXT,
  CERT_KEY_PROV_INFO_PROP_ID, CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_NCRYPT_KEY_SPEC,
  CERT_STORE_OPEN_EXISTING_FLAG, CERT_STORE_PROV_SYSTEM_W, CERT_STORE_READONLY_FLAG,
  CERT_SYSTEM_STORE_CURRENT_USER, CRYPT_ACQUIRE_FLAGS,
  CRYPT_ACQUIRE_ONLY_NCRYPT_KEY_FLAG, CRYPT_ACQUIRE_SILENT_FLAG,
  CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG, CertCloseStore, CertDuplicateCertificateContext,
  CertEnumCertificatesInStore, CertFreeCertificateChain, CertFreeCertificateContext,
  CertGetCertificateChain, CertGetCertificateContextProperty, CertGetNameStringW,
  CertOpenStore, CryptAcquireCertificatePrivateKey, HCERTSTORE, NCRYPT_KEY_HANDLE,
  NCRYPT_PAD_PKCS1_FLAG, NCRYPT_WINDOW_HANDLE_PROPERTY, NCryptFreeObject,
  NCryptSetProperty, NCryptSignHash,
};

use crate::status::{
  Status, describe, listed_despite_silent_open_failure, signing_error,
};

/// `MY`, the store Windows keeps the user's personal certificates in, as a
/// NUL-terminated UTF-16 string.
const PERSONAL_STORE: &[u16] = &[b'M' as u16, b'Y' as u16, 0];

pub(crate) fn list_identities() -> Result<Vec<SigningIdentity>, SigningError> {
  let Some(store) = Store::open_personal()? else {
    return Ok(Vec::new());
  };
  let now = unix_now();
  let mut identities = Vec::new();
  for certificate in store.certificates() {
    // A certificate with no key provider recorded has no private key on this
    // machine. Reading the property touches the store only.
    if !certificate.has_key_provider() {
      continue;
    }
    let Some(identity) = signing_identity(
      certificate.der().to_vec(),
      &certificate.display_name(),
      || certificate.issuer_chain_der(),
      now,
    ) else {
      continue;
    };
    // The recorded provider may point at a key that is gone. Opening it
    // silently tells, and can never prompt: a provider that needs the user
    // to open the key fails with a status instead of asking.
    match certificate.open_key(KeyAccess::Silent) {
      Ok(_key) => {}
      Err(code) if listed_despite_silent_open_failure(code) => {}
      Err(_) => continue,
    }
    identities.push(identity);
  }
  Ok(identities)
}

pub(crate) fn sign_digest(
  identity_id: &str,
  digest: &[u8; 32],
  key_type: SigningKeyType,
  prompt_owner: Option<isize>,
) -> Result<Vec<u8>, SigningError> {
  let Some(store) = Store::open_personal()? else {
    return Err(SigningError::IdentityNotFound);
  };
  let certificate = store
    .certificates()
    .find(|certificate| certificate_fingerprint(certificate.der()) == identity_id)
    .ok_or(SigningError::IdentityNotFound)?;
  // Not silent: a smart card's provider shows its PIN prompt here, on top of
  // the dialog when there is one.
  let key = certificate
    .open_key(KeyAccess::Interactive { prompt_owner })
    .map_err(signing_error)?;
  if let Some(owner) = prompt_owner {
    // Best effort: without it the prompt still shows, only unparented.
    let _ = key.set_prompt_owner(owner);
  }
  let signature = key.sign(digest, key_type).map_err(signing_error)?;
  match key_type {
    SigningKeyType::Rsa => Ok(signature),
    SigningKeyType::Ec => {
      ecdsa_signature_der(&signature).ok_or_else(|| SigningError::SignatureFailed {
        code: SigningErrorCode::SigningFailed,
        detail: format!("unexpected ECDSA signature of {} bytes", signature.len()),
      })
    }
  }
}

fn last_error() -> Status {
  // SAFETY: GetLastError reads the calling thread's last-error value and has
  // no preconditions.
  let code = unsafe { GetLastError() };
  code.cast_signed()
}

/// An open, read-only system store.
struct Store(HCERTSTORE);

impl Store {
  /// The current user's personal store, or `None` when the profile has never
  /// had one.
  fn open_personal() -> Result<Option<Self>, SigningError> {
    // SAFETY: the provider is the system-store provider, whose parameter is a
    // NUL-terminated UTF-16 store name; `PERSONAL_STORE` is one and is
    // 'static. No legacy provider handle is passed.
    let handle = unsafe {
      CertOpenStore(
        CERT_STORE_PROV_SYSTEM_W,
        0,
        0,
        CERT_SYSTEM_STORE_CURRENT_USER
          | CERT_STORE_OPEN_EXISTING_FLAG
          | CERT_STORE_READONLY_FLAG,
        PERSONAL_STORE.as_ptr().cast::<c_void>(),
      )
    };
    if handle.is_null() {
      let code = last_error();
      if code.cast_unsigned() == ERROR_FILE_NOT_FOUND {
        return Ok(None);
      }
      return Err(SigningError::KeychainUnavailable {
        code: SigningErrorCode::KeychainUnavailable,
        detail: describe(code),
      });
    }
    Ok(Some(Self(handle)))
  }

  fn certificates(&self) -> Certificates<'_> {
    Certificates {
      store: self,
      previous: ptr::null(),
    }
  }
}

impl Drop for Store {
  fn drop(&mut self) {
    // SAFETY: the handle came from CertOpenStore and is closed once, here.
    // Without CERT_CLOSE_STORE_FORCE_FLAG the store stays alive for any
    // duplicated certificate context still referring to it.
    unsafe {
      CertCloseStore(self.0, 0);
    }
  }
}

/// The store's certificates, each handed out as its own reference.
struct Certificates<'store> {
  store: &'store Store,
  /// The context the enumeration last returned, which the next call frees.
  previous: *const CERT_CONTEXT,
}

impl Iterator for Certificates<'_> {
  type Item = Certificate;

  fn next(&mut self) -> Option<Certificate> {
    // SAFETY: the store handle is open for `'store`, and `previous` is null
    // or the context the previous call returned, which this call frees.
    let current = unsafe { CertEnumCertificatesInStore(self.store.0, self.previous) };
    self.previous = current;
    if current.is_null() {
      return None;
    }
    // SAFETY: `current` is a live context from the enumeration; duplicating
    // it adds a reference the returned wrapper releases.
    let duplicate = unsafe { CertDuplicateCertificateContext(current) };
    Some(Certificate(duplicate))
  }
}

impl Drop for Certificates<'_> {
  fn drop(&mut self) {
    if !self.previous.is_null() {
      // SAFETY: an enumeration stopped early still owns the context it last
      // returned; freeing it ends the enumeration.
      unsafe {
        CertFreeCertificateContext(self.previous);
      }
    }
  }
}

/// One reference to a certificate context.
struct Certificate(*const CERT_CONTEXT);

impl Drop for Certificate {
  fn drop(&mut self) {
    // SAFETY: the wrapper owns one reference, taken by
    // CertDuplicateCertificateContext, and releases it once.
    unsafe {
      CertFreeCertificateContext(self.0);
    }
  }
}

/// How a key is opened: silently to see whether it exists, or with the
/// provider free to ask the user.
#[derive(Clone, Copy)]
enum KeyAccess {
  Silent,
  Interactive { prompt_owner: Option<isize> },
}

impl Certificate {
  fn der(&self) -> &[u8] {
    // SAFETY: the context is live for `&self`, and its encoded bytes are
    // `cbCertEncoded` long and owned by the context.
    unsafe {
      let context = &*self.0;
      std::slice::from_raw_parts(context.pbCertEncoded, context.cbCertEncoded as usize)
    }
  }

  fn has_key_provider(&self) -> bool {
    let mut size = 0_u32;
    // SAFETY: a null output buffer asks only for the property's size, which
    // is written to `size`; the context is live.
    let found = unsafe {
      CertGetCertificateContextProperty(
        self.0,
        CERT_KEY_PROV_INFO_PROP_ID,
        ptr::null_mut(),
        &raw mut size,
      )
    };
    found != 0
  }

  /// The name Windows itself shows for the certificate: the subject's common
  /// name, or the next best attribute.
  fn display_name(&self) -> String {
    // SAFETY: a null buffer with a zero length asks for the length needed,
    // terminator included; the context is live.
    let length = unsafe {
      CertGetNameStringW(
        self.0,
        CERT_NAME_SIMPLE_DISPLAY_TYPE,
        0,
        ptr::null(),
        ptr::null_mut(),
        0,
      )
    };
    if length <= 1 {
      return String::new();
    }
    let mut name = vec![0_u16; length as usize];
    // SAFETY: `name` holds `length` UTF-16 units, the size just reported.
    let written = unsafe {
      CertGetNameStringW(
        self.0,
        CERT_NAME_SIMPLE_DISPLAY_TYPE,
        0,
        ptr::null(),
        name.as_mut_ptr(),
        length,
      )
    };
    let end = (written as usize).saturating_sub(1).min(name.len());
    String::from_utf16_lossy(&name[..end])
  }

  /// The chain Windows builds above the leaf from what it already holds,
  /// innermost issuer first. As on macOS the trust verdict is ignored, and
  /// nothing is fetched over the network: a picker does not wait on it.
  fn issuer_chain_der(&self) -> Vec<Vec<u8>> {
    let parameters = CERT_CHAIN_PARA {
      cbSize: size_of::<CERT_CHAIN_PARA>() as u32,
      ..Default::default()
    };
    let mut chain: *mut CERT_CHAIN_CONTEXT = ptr::null_mut();
    // SAFETY: the default (current user) engine, the live leaf context, the
    // current time and no extra store; `parameters` and `chain` outlive the
    // call.
    let built = unsafe {
      CertGetCertificateChain(
        ptr::null_mut(),
        self.0,
        ptr::null(),
        ptr::null_mut(),
        &raw const parameters,
        CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL | CERT_CHAIN_DISABLE_AUTH_ROOT_AUTO_UPDATE,
        ptr::null(),
        &raw mut chain,
      )
    };
    if built == 0 || chain.is_null() {
      return Vec::new();
    }
    let leaf = self.der();
    let mut issuers = Vec::new();
    // SAFETY: a built chain context holds `cChain` simple chains, each with
    // `cElement` elements pointing at live certificate contexts, all owned by
    // the chain context until it is freed below.
    unsafe {
      let context = &*chain;
      if context.cChain > 0 {
        let simple = &**context.rgpChain;
        for index in 0..simple.cElement as usize {
          let element = &**simple.rgpElement.add(index);
          let certificate = &*element.pCertContext;
          let der = std::slice::from_raw_parts(
            certificate.pbCertEncoded,
            certificate.cbCertEncoded as usize,
          );
          if der != leaf {
            issuers.push(der.to_vec());
          }
        }
      }
      CertFreeCertificateChain(chain);
    }
    issuers
  }

  fn open_key(&self, access: KeyAccess) -> Result<Key, Status> {
    let mut flags: CRYPT_ACQUIRE_FLAGS = CRYPT_ACQUIRE_ONLY_NCRYPT_KEY_FLAG;
    let mut owner: isize = 0;
    match access {
      KeyAccess::Silent => flags |= CRYPT_ACQUIRE_SILENT_FLAG,
      KeyAccess::Interactive {
        prompt_owner: Some(window),
      } => {
        flags |= CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG;
        owner = window;
      }
      KeyAccess::Interactive { prompt_owner: None } => {}
    }
    let parameters: *const c_void = if flags & CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG == 0 {
      ptr::null()
    } else {
      (&raw const owner).cast()
    };
    let mut handle = 0;
    let mut key_spec = 0;
    let mut caller_frees = 0;
    // SAFETY: the context is live; with CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG the
    // parameter points at an HWND-sized value that outlives the call, and is
    // null otherwise; the three outputs are valid for writes.
    let acquired = unsafe {
      CryptAcquireCertificatePrivateKey(
        self.0,
        flags,
        parameters,
        &raw mut handle,
        &raw mut key_spec,
        &raw mut caller_frees,
      )
    };
    if acquired == 0 {
      return Err(last_error());
    }
    // CRYPT_ACQUIRE_ONLY_NCRYPT_KEY_FLAG guarantees a CNG key handle.
    debug_assert_eq!(key_spec, CERT_NCRYPT_KEY_SPEC);
    Ok(Key {
      handle,
      owned: caller_frees != 0,
    })
  }
}

/// A CNG key handle, freed on drop when the caller owns it.
struct Key {
  handle: NCRYPT_KEY_HANDLE,
  /// False when the handle is cached on the certificate context, which
  /// frees it with the context.
  owned: bool,
}

impl Key {
  fn set_prompt_owner(&self, window: isize) -> Result<(), Status> {
    // SAFETY: the key handle is live; the property is a window handle, read
    // from `window` for its exact size during the call.
    let status = unsafe {
      NCryptSetProperty(
        self.handle,
        NCRYPT_WINDOW_HANDLE_PROPERTY,
        (&raw const window).cast::<u8>(),
        size_of::<isize>() as u32,
        0,
      )
    };
    if status == 0 { Ok(()) } else { Err(status) }
  }

  /// A PKCS #1 v1.5 signature for RSA, the raw `r || s` for ECDSA.
  fn sign(
    &self,
    digest: &[u8; 32],
    key_type: SigningKeyType,
  ) -> Result<Vec<u8>, Status> {
    // PKCS #1 v1.5 over a SHA-256 digest: the provider prepends the
    // DigestInfo that names the hash.
    let pkcs1 = BCRYPT_PKCS1_PADDING_INFO {
      pszAlgId: BCRYPT_SHA256_ALGORITHM,
    };
    let (padding, flags) = match key_type {
      SigningKeyType::Rsa => {
        ((&raw const pkcs1).cast::<c_void>(), NCRYPT_PAD_PKCS1_FLAG)
      }
      SigningKeyType::Ec => (ptr::null(), 0),
    };
    let mut size = 0_u32;
    // SAFETY: a null output buffer asks for the signature's size; the padding
    // info (RSA) lives on this frame, and the digest is 32 bytes.
    let status = unsafe {
      NCryptSignHash(
        self.handle,
        padding,
        digest.as_ptr(),
        digest.len() as u32,
        ptr::null_mut(),
        0,
        &raw mut size,
        flags,
      )
    };
    if status != 0 {
      return Err(status);
    }
    let mut signature = vec![0_u8; size as usize];
    // SAFETY: as above, with an output buffer of the size just reported.
    let status = unsafe {
      NCryptSignHash(
        self.handle,
        padding,
        digest.as_ptr(),
        digest.len() as u32,
        signature.as_mut_ptr(),
        size,
        &raw mut size,
        flags,
      )
    };
    if status != 0 {
      return Err(status);
    }
    signature.truncate(size as usize);
    Ok(signature)
  }
}

impl Drop for Key {
  fn drop(&mut self) {
    if self.owned {
      // SAFETY: the caller owns this handle (the acquire said so) and frees
      // it once, here.
      unsafe {
        NCryptFreeObject(self.handle);
      }
    }
  }
}

#[cfg(test)]
mod tests;
