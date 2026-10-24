import { LinkifyIt } from "linkify-it";
import { getDomain, parse } from "tldts";

export type ChatLinkSpan = {
  start: number;
  end: number;
  text: string;
  href: string;
  hostname: string;
};

const HTTP_SCHEME = /^https?:\/\//iu;
const BARE_HOST_LABEL_START = /^[\p{L}\p{N}]/u;
const UNSAFE_CHARACTERS = /[\s\p{Cc}\p{Cf}\\]/u;
const SPECIAL_USE_SUFFIX =
  /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/iu;
const AMBIGUOUS_FILE_SUFFIXES = new Set([
  "zip",
  "mov",
  "pdf",
  "doc",
  "docx",
  "txt",
  "js",
  "ts",
  "json",
  "xml",
  "html",
]);

export const normalizeChatLink = (input: string) => {
  if (!input || UNSAFE_CHARACTERS.test(input)) {
    return null;
  }
  const explicit = HTTP_SCHEME.test(input);
  if (!explicit && /^[\w+.-]+:/u.test(input)) {
    return null;
  }
  if (!explicit && !BARE_HOST_LABEL_START.test(input)) {
    return null;
  }
  const candidate = explicit ? input : `https://${input}`;
  if (!URL.canParse(candidate)) {
    return null;
  }
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username || url.password || !url.hostname) {
    return null;
  }
  const domain = parse(url.hostname, { allowPrivateDomains: false });
  if (!explicit) {
    if (SPECIAL_USE_SUFFIX.test(url.hostname)) {
      return null;
    }
    if (!domain.isIcann || !domain.domain || domain.isIp) {
      return null;
    }
    if (
      !/^www\./iu.test(input) &&
      domain.publicSuffix &&
      AMBIGUOUS_FILE_SUFFIXES.has(domain.publicSuffix)
    ) {
      return null;
    }
  }
  return { href: url.href, hostname: url.hostname };
};

export const getChatLinkSite = (hostname: string): string | null =>
  getDomain(hostname, { allowPrivateDomains: false });

export const detectChatLinks = (text: string): ChatLinkSpan[] => {
  // Candidate suffixes come from the input; tldts is the sole TLD authority.
  // This keeps new ICANN suffixes detectable without a second hand-maintained list.
  const suffixes = Array.from(
    text.matchAll(/\.([\p{L}\p{N}-]+)/gu),
    (match) => match[1] ?? "",
  );
  // Include credentials in the candidate so normalization rejects the whole URL,
  // rather than exposing a misleading truncated anchor before its @ character.
  const linkify = new LinkifyIt({
    fuzzyLink: true,
    fuzzyEmail: false,
    fuzzyIP: false,
    urlAuth: true,
  })
    .tlds(suffixes)
    .add("ftp:", null)
    .add("mailto:", null)
    .add("//", null);
  const spans: ChatLinkSpan[] = [];
  for (const match of linkify.match(text) ?? []) {
    const explicit = HTTP_SCHEME.test(match.raw);
    const preceding = text.slice(0, match.index).at(-1);
    if (!explicit && preceding && /[\p{L}\p{N}_@/\\:.-]/u.test(preceding)) {
      continue;
    }
    const normalized = normalizeChatLink(match.raw);
    if (!normalized) {
      continue;
    }
    spans.push({
      start: match.index,
      end: match.lastIndex,
      text: match.raw,
      href: normalized.href,
      hostname: normalized.hostname,
    });
  }
  return spans;
};
