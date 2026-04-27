const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const ALLOWED_TARGETS = new Set(["_blank", "_self", "_parent", "_top"]);

export function sanitizeExternalUrl(
  rawUrl: string | undefined,
): string | undefined {
  if (!rawUrl) {
    return undefined;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
      return undefined;
    }
    if (
      (parsed.protocol === "mailto:" || parsed.protocol === "tel:") &&
      parsed.pathname.trim() === ""
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function normalizeUserUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("mailto:") || normalized.startsWith("tel:")) {
    return sanitizeExternalUrl(trimmed) ?? "";
  }

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return sanitizeExternalUrl(trimmed) ?? "";
  }

  // Protocol-less input with a colon is either host:port, bracketed IPv6,
  // or an unsupported scheme. Reject the scheme-like forms before adding https.
  const colonIndex = trimmed.indexOf(":");
  const firstPathSeparatorIndex = findFirstPathSeparatorIndex(trimmed);
  const colonIsInAuthority =
    colonIndex > 0 &&
    !trimmed.startsWith("[") &&
    (firstPathSeparatorIndex === -1 || colonIndex < firstPathSeparatorIndex);
  if (colonIsInAuthority) {
    const suffix = trimmed.slice(colonIndex + 1);
    if (suffix.startsWith("//") || !startsWithPortSuffix(suffix)) {
      return "";
    }
  }

  const withProtocol = `https://${trimmed}`;
  return sanitizeExternalUrl(withProtocol) ?? "";
}

export function isAllowedUserUrl(rawUrl: string): boolean {
  return normalizeUserUrl(rawUrl) !== "";
}

export function sanitizeLinkTarget(target: string | undefined): string {
  return target && ALLOWED_TARGETS.has(target) ? target : "_blank";
}

function findFirstPathSeparatorIndex(value: string): number {
  const indexes = [value.indexOf("/"), value.indexOf("?"), value.indexOf("#")]
    .filter((index) => index >= 0)
    .toSorted((a, b) => a - b);
  return indexes.at(0) ?? -1;
}

function startsWithPortSuffix(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  let index = 0;
  while (index < value.length) {
    const char = value.codePointAt(index) ?? 0;
    if (char < 48 || char > 57) {
      break;
    }
    index += 1;
  }

  return index > 0 && (index === value.length || "/?#".includes(value[index]!));
}
