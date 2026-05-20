import { Result } from "better-result";
import * as cheerio from "cheerio";

import {
  parseSafeOutboundUrl,
  safeOutboundFetchBytes,
} from "@/api/lib/safe-outbound-fetch";

const ICON_DISCOVERY_TIMEOUT_MS = 5000;
const ICON_HTML_MAX_CHARS = 200_000;
const ICON_HTML_MAX_BYTES = 300_000;

export const discoverMcpIconUrl = async (
  rawUrl: string,
): Promise<string | null> => {
  const parsed = parseSafeOutboundUrl(rawUrl);
  if (Result.isError(parsed)) {
    return null;
  }

  const rootUrl = new URL("/", parsed.value.origin);
  const htmlResult = await Result.tryPromise({
    try: async () => {
      const response = await safeOutboundFetchBytes({
        headers: { Accept: "text/html" },
        maxBytes: ICON_HTML_MAX_BYTES,
        timeoutMs: ICON_DISCOVERY_TIMEOUT_MS,
        url: rootUrl,
      });
      if (Result.isError(response) || !response.value.ok) {
        return null;
      }

      return new TextDecoder()
        .decode(response.value.body)
        .slice(0, ICON_HTML_MAX_CHARS);
    },
    catch: () => null,
  });

  if (Result.isOk(htmlResult) && htmlResult.value) {
    const discovered = findIconInHtml({
      html: htmlResult.value,
      rootUrl,
    });
    if (discovered) {
      return discovered;
    }
  }

  return new URL("/favicon.ico", parsed.value.origin).toString();
};

const ICON_REL_PRIORITY = [
  "apple-touch-icon",
  "icon",
  "shortcut icon",
] as const;

const findIconInHtml = ({
  html,
  rootUrl,
}: {
  html: string;
  rootUrl: URL;
}): string | null => {
  const $ = cheerio.load(html);

  for (const rel of ICON_REL_PRIORITY) {
    const href = $(`link[rel="${rel}"]`).attr("href");
    if (!href) {
      continue;
    }

    const iconUrl = new URL(href, rootUrl);
    const safe = parseSafeOutboundUrl(iconUrl.toString());
    if (Result.isOk(safe)) {
      return safe.value.toString();
    }
  }

  return null;
};
