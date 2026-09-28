import { describe, expect, test } from "bun:test";

import { discoverCzCsvUrl, discoverEuXmlUrl } from "./source-fetch";

const euMetadata = (downloadUrl: string) => ({
  "@graph": [
    {
      "@type": "dcat:Distribution",
      "dct:title": [
        {
          "@language": "en",
          "@value": "Consolidated Financial Sanctions File 1.1",
        },
      ],
      "dct:format": {
        "@id": "http://publications.europa.eu/resource/authority/file-type/XML",
      },
      "dcat:downloadURL": { "@id": downloadUrl },
    },
  ],
});

describe("publisher download discovery", () => {
  test("takes the XML 1.1 distribution from EU metadata with its current query token", () => {
    const url =
      "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=example";
    const found = discoverEuXmlUrl(euMetadata(url));
    expect(found.isOk()).toBe(true);
    expect(found.unwrap()).toBe(url);
  });

  test("rejects a distribution redirected to a different host without exposing its query", () => {
    const found = discoverEuXmlUrl(
      euMetadata(
        "https://example.test/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=private",
      ),
    );
    expect(found.isErr()).toBe(true);
    expect(found.error.message).not.toContain("private");
  });

  test("selects the latest dated CSV from the Czech ministry page", () => {
    const found = discoverCzCsvUrl(`
      <a href="/file/1/Vnitrostatni_sankcni_seznam_2025_01_01.csv">old</a>
      <a href="/file/2/Vnitrostatni_sankcni_seznam_2026_07_23.csv">new</a>
      <a href="https://example.test/file/3/Vnitrostatni_sankcni_seznam_2027_01_01.csv">foreign</a>
    `);
    expect(found.isOk()).toBe(true);
    expect(found.unwrap()).toBe(
      "https://mzv.gov.cz/file/2/Vnitrostatni_sankcni_seznam_2026_07_23.csv",
    );
  });
});
