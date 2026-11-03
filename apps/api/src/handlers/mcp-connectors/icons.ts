import { Result } from "better-result";
import { decodeHTMLAttribute } from "entities";

import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { parseSafeOutboundUrl } from "@/api/lib/safe-outbound-fetch";

const ICON_DISCOVERY_TIMEOUT_MS = 5000;
const ICON_HTML_MAX_CHARS = 200_000;
const ICON_HTML_MAX_BYTES = 300_000;

export const discoverMcpIconUrl = async (
  rawUrl: string,
  permit: ThirdPartyOutboundPermit,
): Promise<string | null> => {
  const parsed = parseSafeOutboundUrl(rawUrl);
  if (Result.isError(parsed)) {
    return null;
  }

  const rootUrl = new URL("/", parsed.value.origin);
  const htmlResult = await Result.tryPromise({
    try: async () => {
      const response = await safeOutboundFetchBytes({
        permit,
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

export const findIconInHtml = ({
  html,
  rootUrl,
}: {
  html: string;
  rootUrl: URL;
}): string | null => {
  const hrefs = new Map<string, string | null>();
  new HTMLRewriter()
    .on("link", {
      element(el) {
        const rawRel = el.getAttribute("rel");
        if (rawRel === null) {
          return;
        }
        const decodedRel = decodeHTMLAttribute(rawRel).toLowerCase();
        const rel = ICON_REL_PRIORITY.find((value) => value === decodedRel);
        if (rel === undefined || hrefs.has(rel)) {
          return;
        }
        const rawHref = el.getAttribute("href");
        hrefs.set(rel, rawHref === null ? null : decodeHTMLAttribute(rawHref));
      },
    })
    .transform(html);

  for (const rel of ICON_REL_PRIORITY) {
    const href = hrefs.get(rel);
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
