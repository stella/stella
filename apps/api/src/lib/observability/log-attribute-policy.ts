// Attribute keys the logger refuses to ship. Dependency-free on purpose: the
// logger imports it, and the `no-redacted-log-attribute-key` lint rule pins
// the same pattern at the call site, so a key that would be dropped here is
// an error where it is written instead of a silent `log.attributes_dropped`.
// The rule cannot import this module, so its copy is held equal by
// apps/api/src/tests/security/oxlint-guardrails.test.ts.
export const SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN =
  /(?:body|content|email|fileName|message|name|title|password|secret|credential|authorization|cookie|bearer|api[_-]?key|prompt(?!_?token)|snippet|subject|phone)/iu;
