import { Result } from "better-result";
import * as cheerio from "cheerio";

import {
  parseSafeMcpUrl,
  validateSafeMcpFetchUrl,
} from "@/api/handlers/mcp-connectors/url-safety";

const ICON_DISCOVERY_TIMEOUT_MS = 5000;
const ICON_HTML_MAX_CHARS = 200_000;

export const discoverMcpIconUrl = async (
  rawUrl: string,
): Promise<string | null> => {
  const parsed = parseSafeMcpUrl(rawUrl);
  if (Result.isError(parsed)) {
    return null;
  }

  const rootUrlResult = await validateSafeMcpFetchUrl(
    new URL("/", parsed.value.origin),
  );
  if (Result.isError(rootUrlResult)) {
    return null;
  }
  const rootUrl = rootUrlResult.value;
  const htmlResult = await Result.tryPromise({
    try: async () => {
      const response = await fetch(rootUrl, {
        headers: { Accept: "text/html" },
        redirect: "error",
        signal: AbortSignal.timeout(ICON_DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        return null;
      }

      return (await response.text()).slice(0, ICON_HTML_MAX_CHARS);
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
    const safe = parseSafeMcpUrl(iconUrl.toString());
    if (Result.isOk(safe)) {
      return safe.value.toString();
    }
  }

  return null;
};
