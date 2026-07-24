/**
 * Deterministic, regex-based redaction for agent-authored feedback text.
 *
 * Both agent surfaces (`@stll/anonymize-cli`, `@stll/anonymize-mcp`) can file a
 * bug or gap via feedback. The free-text title/body can accidentally carry a
 * client email, an id, an auth token, or an internal URL. This module strips the
 * obvious shapes before the text is ever shown to a human or placed into a
 * prefilled GitHub issue URL. It is a coarse safety net, not a guarantee: the
 * real control is human approval (nothing is published until the human opens and
 * submits the prefilled issue) and the fact that this surface never sends over
 * the network. The heavy WASM anonymization pipeline is deliberately not run
 * here: feedback is short free text, and regex plus human approval is the
 * accepted baseline (it also keeps this module runtime-free).
 *
 * Pass order is load-bearing: JWT/secret shapes run before URL so a secret in a
 * query string of a preserved public URL is still redacted while the URL is kept.
 */

const REDACTED_EMAIL = "[redacted-email]";
const REDACTED_ID = "[redacted-id]";
const REDACTED_SECRET = "[redacted-secret]";
const REDACTED_URL = "[redacted-url]";
const REDACTED_IP = "[redacted-ip]";

const hasNoPrivateUrlParts = (url: URL): boolean =>
  url.username === "" &&
  url.password === "" &&
  url.search === "" &&
  url.hash === "";

/**
 * The only URL preserved verbatim is the project's own public GitHub repo, so a
 * feedback body can reference an existing issue or file without being redacted.
 * Everything else (including other hosts) is stripped.
 */
const isPreservedPublicUrl = (url: URL): boolean => {
  if (!hasNoPrivateUrlParts(url)) {
    return false;
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    return false;
  }
  return (
    url.pathname === "/stella/anonymize" ||
    url.pathname.startsWith("/stella/anonymize/")
  );
};

// Three dot-separated base64url segments, each long enough to be a real token
// (>= 10 chars), so version strings ("1.2.3") and IPv4 literals never match.
const JWT_REGEX =
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;

// Long hex blob (>= 32 chars): API keys, hashes, un-hyphenated ids.
const HEX_SECRET_REGEX = /\b[0-9a-fA-F]{32,}\b/gu;

// Long base64url blob (>= 40 chars): opaque access tokens, secrets. The
// base64url alphabet (no `+` or `/`) is used on purpose: including `/` would let
// this pass swallow whole URL path segments, and modern tokens (GitHub PATs, JWT
// parts, most API keys) are base64url anyway. A hex secret is caught by
// HEX_SECRET_REGEX above.
const BASE64_SECRET_REGEX = /\b[A-Za-z0-9_-]{40,}={0,2}/gu;

// Absolute http(s) URL. Parentheses/brackets are valid path characters and are
// intentionally included; unmatched closing wrappers and sentence punctuation
// are trimmed in the replacer.
const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const URL_TRAILING_PUNCTUATION_REGEX = /[.,;:!?]+$/u;

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;

const UUID_REGEX =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gu;

const IPV4_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\b/gu;

// Full-form and mid/tail-compressed IPv6. Fully leading-compressed forms
// ("::1") are intentionally out of scope: requiring at least one leading hex
// group keeps code tokens like `std::vector` from being misread as an address.
const IPV6_REGEX =
  /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/gu;

export type SanitizeFeedbackResult = { text: string; redactions: number };

const trimTrailingUrlPunctuation = (
  match: string,
): { core: string; trailing: string } => {
  let core = match;
  let trailing = "";

  const sentencePunctuation =
    URL_TRAILING_PUNCTUATION_REGEX.exec(core)?.[0] ?? "";
  if (sentencePunctuation.length > 0) {
    core = core.slice(0, -sentencePunctuation.length);
    trailing = sentencePunctuation;
  }

  const pairs = [
    { open: "(", close: ")" },
    { open: "[", close: "]" },
    { open: "{", close: "}" },
  ] as const;
  let changed = true;
  while (changed) {
    changed = false;
    for (const { close, open } of pairs) {
      if (!core.endsWith(close)) {
        continue;
      }
      const opens = Array.from(core).filter((char) => char === open).length;
      const closes = Array.from(core).filter((char) => char === close).length;
      if (closes <= opens) {
        continue;
      }
      core = core.slice(0, -close.length);
      trailing = `${close}${trailing}`;
      changed = true;
    }
  }

  return { core, trailing };
};

/**
 * Redact the well-known sensitive shapes from one feedback field. Returns the
 * cleaned text and the number of substitutions made (surfaced to the human so
 * they can judge how much was stripped). Each pass replaces with a bracketed
 * placeholder, so a downstream pass never re-matches an earlier placeholder.
 */
export const sanitizeFeedbackText = (input: string): SanitizeFeedbackResult => {
  let redactions = 0;
  const bump = (): void => {
    redactions += 1;
  };

  let text = input;

  text = text.replace(JWT_REGEX, () => {
    bump();
    return REDACTED_SECRET;
  });
  text = text.replace(HEX_SECRET_REGEX, () => {
    bump();
    return REDACTED_SECRET;
  });
  text = text.replace(BASE64_SECRET_REGEX, () => {
    bump();
    return REDACTED_SECRET;
  });
  text = text.replace(URL_REGEX, (match) => {
    const { core, trailing } = trimTrailingUrlPunctuation(match);
    let url: URL;
    try {
      url = new URL(core);
    } catch {
      // Not a parseable URL; leave it untouched rather than guess.
      return match;
    }
    if (isPreservedPublicUrl(url)) {
      return match;
    }
    bump();
    return `${REDACTED_URL}${trailing}`;
  });
  text = text.replace(EMAIL_REGEX, () => {
    bump();
    return REDACTED_EMAIL;
  });
  text = text.replace(UUID_REGEX, () => {
    bump();
    return REDACTED_ID;
  });
  text = text.replace(IPV4_REGEX, () => {
    bump();
    return REDACTED_IP;
  });
  text = text.replace(IPV6_REGEX, () => {
    bump();
    return REDACTED_IP;
  });

  return { text, redactions };
};
