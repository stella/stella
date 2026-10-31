//! Reads preferences an administrator set for the app. A value counts only
//! when a configuration profile forces it or it lives in the machine-wide
//! (any user, any host) preferences file; both need an administrator.
//! Values in the user's own domain are ignored, so a process running as the
//! user cannot grant itself what only an administrator may.

use objc2_core_foundation::{
  CFBoolean, CFPreferencesAppValueIsForced, CFPreferencesCopyAppValue,
  CFPreferencesCopyValue, CFRetained, CFString, CFType, kCFPreferencesAnyHost,
  kCFPreferencesAnyUser,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedPreference {
  Bool(bool),
  String(String),
  /// Present, but neither a boolean nor a string.
  Unsupported,
}

pub fn managed_preference(domain: &str, key: &str) -> Option<ManagedPreference> {
  let domain = CFString::from_str(domain);
  let key = CFString::from_str(key);
  let value = if CFPreferencesAppValueIsForced(&key, &domain) {
    CFPreferencesCopyAppValue(&key, &domain)
  } else {
    // SAFETY: CoreFoundation exports these as immutable constant strings
    // that live for the whole process.
    let (user, host) = unsafe { (kCFPreferencesAnyUser, kCFPreferencesAnyHost) };
    CFPreferencesCopyValue(&key, &domain, user, host)
  }?;
  Some(classify(value))
}

fn classify(value: CFRetained<CFType>) -> ManagedPreference {
  let value = match value.downcast::<CFBoolean>() {
    Ok(flag) => return ManagedPreference::Bool(flag.as_bool()),
    Err(value) => value,
  };
  match value.downcast::<CFString>() {
    Ok(text) => ManagedPreference::String(text.to_string()),
    Err(_) => ManagedPreference::Unsupported,
  }
}
