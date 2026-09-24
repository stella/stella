import { Result } from "better-result";
import { describe, expect, it } from "bun:test";

import { publisherTarget } from "@/api/handlers/case-law/ingestion/adapters/publisher-target";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

const refusal = (url: string): string | undefined => {
  const checked = publisherTarget(ADAPTER_KEYS.EU_ECJ, url);
  return Result.isError(checked) ? checked.error.message : undefined;
};

describe("publisherTarget", () => {
  it("passes a URL on the adapter's publisher host, without its fragment", () => {
    const checked = publisherTarget(
      ADAPTER_KEYS.EU_ECJ,
      "https://publications.europa.eu/resource/cellar/abc.0011.03/DOC_1#top",
    );

    expect(checked.unwrapOr(undefined)).toBe(
      "https://publications.europa.eu/resource/cellar/abc.0011.03/DOC_1",
    );
  });

  it("holds each adapter to its own publisher", () => {
    const url = "https://obcan.justice.sk/content/public/item/1";

    expect(
      publisherTarget(ADAPTER_KEYS.SK_COURTS, url).unwrapOr(undefined),
    ).toBe(url);
    expect(Result.isError(publisherTarget(ADAPTER_KEYS.EU_ECJ, url))).toBe(
      true,
    );
  });

  it.each([
    ["a foreign host", "https://example.com/resource/cellar/abc"],
    ["a subdomain of the publisher", "https://x.publications.europa.eu/doc"],
    ["plain http", "http://publications.europa.eu/resource/cellar/abc"],
    ["a non-default port", "https://publications.europa.eu:8443/doc"],
    ["credentials", "https://user:pass@publications.europa.eu/doc"],
    ["a loopback address", "https://127.0.0.1/doc"],
    ["a link-local address", "https://169.254.169.254/latest/meta-data"],
    ["an IPv6 literal", "https://[::1]/doc"],
    ["a relative link", "/resource/cellar/abc"],
  ])("refuses %s", (_case, url) => {
    expect(refusal(url)).toBeString();
  });
});
