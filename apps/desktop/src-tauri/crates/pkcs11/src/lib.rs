//! What the desktop and its PKCS #11 helper process share.
//!
//! Some smart cards and USB tokens reach macOS only through their vendor's
//! PKCS #11 module: no CryptoTokenKit extension puts their keys in the
//! keychain. The desktop signs with those through `stella-pkcs11-helper`, a
//! separate, short-lived process that loads the module, answers one request
//! and exits, so a vendor's native code never runs inside the app.
//!
//! - [`protocol`]: the one request a helper answers and its response.
//! - [`drivers`]: the modules the desktop looks for, and where.
//! - [`macho`]: whether a module can load into this process at all.
//! - [`digest_info`]: what an RSA token signs for a SHA-256 digest.

pub mod digest_info;
pub mod drivers;
pub mod macho;
pub mod protocol;
