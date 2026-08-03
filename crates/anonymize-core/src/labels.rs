//! Built-in entity label names the core compares against.
//!
//! Entity labels are open-ended strings at the API boundary (callers can
//! request any label), but detectors and resolution passes special-case
//! the built-in ones below. Compare through these constants; do not
//! inline the strings.

pub(crate) const ADDRESS_LABEL: &str = "address";
pub(crate) const BIRTH_NUMBER_LABEL: &str = "birth number";
pub(crate) const CASE_NUMBER_LABEL: &str = "case number";
pub(crate) const CREDIT_CARD_NUMBER_LABEL: &str = "credit card number";
pub(crate) const COUNTRY_LABEL: &str = "country";
pub(crate) const DATE_LABEL: &str = "date";
pub(crate) const IP_ADDRESS_LABEL: &str = "ip address";
pub(crate) const IDENTITY_CARD_NUMBER_LABEL: &str = "identity card number";
pub(crate) const LOCATION_LABEL: &str = "location";
pub(crate) const MONETARY_AMOUNT_LABEL: &str = "monetary amount";
pub(crate) const ORGANIZATION_LABEL: &str = "organization";
pub(crate) const PERSON_LABEL: &str = "person";
pub(crate) const PHONE_NUMBER_LABEL: &str = "phone number";
pub(crate) const PASSPORT_NUMBER_LABEL: &str = "passport number";
pub(crate) const REGISTRATION_NUMBER_LABEL: &str = "registration number";
