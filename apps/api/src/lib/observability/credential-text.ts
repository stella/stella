// Three dot-separated base64url segments, each long enough to be a real token
// (>= 10 chars), so version strings ("1.2.3") and IPv4 literals never match.
const JWT_REGEX =
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;

// Long hex blob (>= 32 chars): API keys, hashes, un-hyphenated ids.
const HEX_SECRET_REGEX = /\b[0-9a-fA-F]{32,}\b/gu;

// Long base64url blob (>= 40 chars): opaque access tokens, secrets. The
// base64url alphabet (no `+` or `/`) is used on purpose: including `/` would
// let this pass swallow whole URL path segments, and modern tokens (GitHub
// PATs, JWT parts, most API keys) are base64url anyway. A hex secret is caught
// by HEX_SECRET_REGEX above.
const BASE64_SECRET_REGEX = /\b[A-Za-z0-9_-]{40,}={0,2}/gu;

const REDACTED_SECRET = "[redacted-secret]";
// Provider keys, including the masked forms providers echo back in errors
// ("sk-proj-****abcd", "sk-ab…wxyz"): the visible fragment is still a key.
const PREFIXED_SECRET_REGEX =
  /\b(?:sk-[A-Za-z0-9_*.\u2026-]*[A-Za-z0-9_*\u2026]|AIza[A-Za-z0-9_-]+|hf_[A-Za-z0-9]+)/gu;
// Userinfo in a URL ("https://user:token@host/…").
const URL_CREDENTIALS_REGEX = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu;
const BEARER_SECRET_REGEX =
  /(\bBearer\s+)[A-Za-z0-9_~+/-]+(?:\.[A-Za-z0-9_~+/-]+)*=*/giu;

/** Secret-only text projection; the surrounding provider diagnostic stays whole. */
export const sanitizeCredentialText = (
  input: string,
  secrets: readonly string[] = [],
) => {
  let text = input;
  let redactions = 0;
  for (const secret of secrets) {
    if (secret === "") {
      continue;
    }
    const parts = text.split(secret);
    redactions += parts.length - 1;
    text = parts.join(REDACTED_SECRET);
  }
  const redact = () => {
    redactions += 1;
    return REDACTED_SECRET;
  };
  for (const pattern of [JWT_REGEX, PREFIXED_SECRET_REGEX]) {
    text = text.replace(pattern, redact);
  }
  text = text.replace(BEARER_SECRET_REGEX, (_match, scheme: string) => {
    redactions += 1;
    return `${scheme}${REDACTED_SECRET}`;
  });
  text = text.replace(URL_CREDENTIALS_REGEX, (_match, scheme: string) => {
    redactions += 1;
    return `${scheme}${REDACTED_SECRET}@`;
  });
  return { text, redactions };
};

export const sanitizeFeedbackSecrets = (input: string) => {
  const credentialPass = sanitizeCredentialText(input);
  let { text, redactions } = credentialPass;
  const redact = () => {
    redactions += 1;
    return REDACTED_SECRET;
  };
  for (const pattern of [HEX_SECRET_REGEX, BASE64_SECRET_REGEX]) {
    text = text.replace(pattern, redact);
  }
  return { text, redactions };
};
