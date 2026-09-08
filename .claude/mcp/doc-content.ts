import { DOC_SOURCES } from "./doc-sources";
import type { FetchedAllowedUrl } from "./fetch-allowed-url";

export const MAX_FETCH_DOC_CHARS = 12_000;

const markdownPageRules = Object.values(DOC_SOURCES).flatMap((source) =>
  "markdownPages" in source
    ? [
        {
          hostname: new URL(source.url).hostname,
          ...source.markdownPages,
        },
      ]
    : [],
);

const hasStableTextPath = (pathname: string): boolean => {
  const basename = pathname.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    basename.length === 0 ||
    basename === "index" ||
    basename.startsWith("index.") ||
    basename.endsWith(".md") ||
    basename.endsWith(".txt")
  );
};

export const resolveMarkdownDocUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  if (hasStableTextPath(url.pathname)) {
    return rawUrl;
  }

  const rule = markdownPageRules.find(
    ({ hostname, pathIncludes }) =>
      hostname === url.hostname && url.pathname.includes(pathIncludes),
  );
  if (!rule) {
    return rawUrl;
  }

  if (rule.rewrite === "append-md") {
    const basename = url.pathname.split("/").at(-1) ?? "";
    if (basename.includes(".")) {
      return rawUrl;
    }
    url.pathname = `${url.pathname}.md`;
    return url.toString();
  }

  if (!url.pathname.toLowerCase().endsWith(".html")) {
    return rawUrl;
  }
  url.pathname = `${url.pathname.slice(0, -".html".length)}.md`;
  return url.toString();
};

const normalizedContentType = (contentType: string | null): string | null =>
  contentType?.split(";").at(0)?.trim().toLowerCase() ?? null;

const looksLikeHtmlDocument = (text: string): boolean => {
  let prefix = text.replace(/^\uFEFF/u, "").trimStart();
  while (true) {
    const preamble = prefix.match(/^(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->)/iu);
    if (!preamble) {
      break;
    }
    prefix = prefix.slice(preamble[0].length).trimStart();
  }
  return /^(?:<!doctype\s+html\b|<html\b)/iu.test(prefix.slice(0, 256));
};

export const readableDocText = ({
  contentType,
  text,
  url,
}: FetchedAllowedUrl): string => {
  const type = normalizedContentType(contentType);
  if (
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    looksLikeHtmlDocument(text)
  ) {
    throw new Error(
      `Documentation source ${url} returned HTML, which is not sent to the model. Use search_docs to select a Markdown or plain-text URL from the source index, then call fetch_doc_chunks with that URL.`,
    );
  }
  return text;
};

export const formatFetchDocsOutput = ({
  text,
  url,
}: {
  text: string;
  url: string;
}): string => {
  if (text.length <= MAX_FETCH_DOC_CHARS) {
    return text;
  }

  const nextCall = JSON.stringify({
    url,
    query: "the specific API or behavior you need",
    maxChunks: 3,
  });
  const detailedNotice =
    `\n\n[Response truncated at ${MAX_FETCH_DOC_CHARS} characters. ` +
    `Call fetch_doc_chunks with ${nextCall}.]`;
  const notice =
    detailedNotice.length < MAX_FETCH_DOC_CHARS
      ? detailedNotice
      : `\n\n[Response truncated at ${MAX_FETCH_DOC_CHARS} characters. Call fetch_doc_chunks with the same URL and a specific query.]`;
  const bodyLimit = Math.max(0, MAX_FETCH_DOC_CHARS - notice.length);
  return `${text.slice(0, bodyLimit).trimEnd()}${notice}`;
};
