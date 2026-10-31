import { describe, expect, test } from "bun:test";

import { buildSourceMentionOptions } from "@/features/chat/chat-source-mentions";

describe("buildSourceMentionOptions", () => {
  test("builds the Sources group from the corpora, the catalog and the user's connections", () => {
    const options = buildSourceMentionOptions({
      caseLawCountries: ["CZE"],
      legislationCountries: ["CZE"],
      corpusLabel: ({ corpus, country }) => `${corpus} · ${country}`,
      catalog: {
        nativeTools: [
          { slug: "ares", displayName: "ARES", enabled: true },
          { slug: "brreg", displayName: "Brønnøysund", enabled: false },
          // A native tool that is not a business registry is not a source chip.
          { slug: "boe", displayName: "BOE", enabled: true },
        ],
        connectors: [
          { id: "c1", displayName: "Legal Search" },
          { id: "c2", displayName: "Notes" },
          { id: "c3", displayName: "Archive" },
        ],
      },
      connections: [
        {
          connectorId: "c1",
          connectorSlug: "legal-search",
          enabled: true,
          status: "connected",
        },
        // Switched off, and waiting on re-authorization: no tools to scope to.
        {
          connectorId: "c2",
          connectorSlug: "notes",
          enabled: false,
          status: "connected",
        },
        {
          connectorId: "c3",
          connectorSlug: "archive",
          enabled: true,
          status: "needs_reauth",
        },
        // A connection whose connector the catalog does not list has no name.
        {
          connectorId: "gone",
          connectorSlug: "gone",
          enabled: true,
          status: "connected",
        },
      ],
    });

    expect(options).toEqual([
      {
        category: "corpus",
        kind: "corpus",
        label: "case_law · CZE",
        mimeType: null,
        scope: { corpus: "case_law", country: "CZE" },
      },
      {
        category: "corpus",
        kind: "corpus",
        label: "legislation · CZE",
        mimeType: null,
        scope: { corpus: "legislation", country: "CZE" },
      },
      {
        category: "registry",
        kind: "registry",
        label: "ARES",
        mimeType: null,
        registry: "ares",
      },
      {
        category: "connector",
        kind: "connector",
        label: "Legal Search",
        mimeType: null,
        connector: "legal-search",
      },
    ]);
  });

  test("offers no corpora when none are given", () => {
    expect(
      buildSourceMentionOptions({
        caseLawCountries: [],
        legislationCountries: [],
        corpusLabel: () => "unused",
        catalog: { nativeTools: [], connectors: [] },
        connections: [],
      }),
    ).toEqual([]);
  });

  test("offers only the corpora when the connector catalog could not be read", () => {
    expect(
      buildSourceMentionOptions({
        caseLawCountries: ["CZE"],
        legislationCountries: [],
        corpusLabel: ({ corpus, country }) => `${corpus} · ${country}`,
        catalog: null,
        connections: [
          {
            connectorId: "c1",
            connectorSlug: "legal-search",
            enabled: true,
            status: "connected",
          },
        ],
      }).map((option) => option.label),
    ).toEqual(["case_law · CZE"]);
  });
});
