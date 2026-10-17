import { Result } from "better-result";

const CELEX_SECONDARY =
  /^(?:3\d{4}[RLDS]\d{4,}(?:\(\d+\))?(?:R\(\d+\))?|0\d{4}[RLDS]\d{4,}(?:\(\d+\))?-\d{8})$/u;
const CELEX_PRIMARY = /^1\d{4}[MEP]\/TXT$/u;
const ELI_SECONDARY =
  /^\/eli\/(?:reg|dir|dec)(?:_del|_impl)?\/\d{4}\/[1-9]\d*(?:\(\d+\))?(?:\/[a-zA-Z0-9_.()-]+)*$/u;
const ELI_PRIMARY =
  /^\/eli\/treaty\/(?:teu|tfeu|char)_\d{4}(?:\/[a-zA-Z0-9_.()-]+)*$/u;

/**
 * Canonical publisher identifiers, without asserting that two identifiers name
 * the same work. CELEX cannot recover delegated/implementing ELI kinds, and an
 * ELI decision does not distinguish legacy ECSC (S) from other decisions (D).
 * Euratom uses the same R/L/D codes. Number qualifiers, corrigenda, consolidation
 * dates and ELI expression/format suffixes retain their identity.
 *
 * Accepts bare/prefixed CELEX, EUR-Lex CELEX links, and EU publisher ELI links;
 * returns uppercase CELEX or the http://data.europa.eu ELI namespace, or null.
 */
export const normalizeEuLegalIdentifier = (raw: string): string | null => {
  const value = raw.trim();
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    return null;
  }
  const celex = value.replace(/^CELEX:/iu, "").toUpperCase();
  if (CELEX_SECONDARY.test(celex) || CELEX_PRIMARY.test(celex)) {
    return celex;
  }
  const url = Result.try(() => new URL(value)).unwrapOr(null);
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return null;
  }
  if (url.hostname === "eur-lex.europa.eu") {
    const uris = url.searchParams.getAll("uri");
    if (new Set(uris.map((uri) => uri.toUpperCase())).size > 1) {
      return null;
    }
    const uri = uris.at(0);
    if (uri !== undefined && /^CELEX:/iu.test(uri)) {
      const identifier = uri.slice("CELEX:".length).toUpperCase();
      return CELEX_SECONDARY.test(identifier) || CELEX_PRIMARY.test(identifier)
        ? identifier
        : null;
    }
  }
  if (
    (url.hostname !== "data.europa.eu" &&
      url.hostname !== "eur-lex.europa.eu") ||
    url.search !== "" ||
    url.hash !== "" ||
    /%(?:2f|5c)/iu.test(url.pathname)
  ) {
    return null;
  }
  const path = Result.try(() => decodeURIComponent(url.pathname))
    .unwrapOr("")
    .replace(/\/$/u, "");
  if (!ELI_SECONDARY.test(path) && !ELI_PRIMARY.test(path)) {
    return null;
  }
  return `http://data.europa.eu${path}`;
};
