import { describe, expect, test } from "bun:test";

import { BUSINESS_REGISTRY_SLUGS } from "@stll/api-contract";
import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import {
  UNTRUSTED_CONTENT_CLOSE,
  UNTRUSTED_CONTENT_OPEN,
} from "@stll/api-contract/untrusted-content-fence";

import {
  externalMcpCitedAssistantMessageFixture,
  externalMcpGetDocumentResponseFixture,
  externalMcpSearchResponseFixture,
} from "@/components/chat/__fixtures__/external-mcp";
import {
  collectExternalSources,
  collectSourceChipEntries,
  courtTierForSource,
  dedupeExternalSources,
  sortCourtTiers,
} from "@/components/chat/source-chips.logic";
import type { ExternalSourceEntry } from "@/components/chat/source-chips.logic";

const APP_ORIGINS: ReadonlySet<string> = new Set(["https://app.test"]);

describe("external source extraction from tool output", () => {
  test("keeps a root-relative URL only when it opens a legal reader page", () => {
    const sources: ExternalSourceEntry[] = [];
    collectExternalSources(
      [
        { title: "Civil Code", url: "/law/cz/statutes/civil-code" },
        { title: "Billing", url: "/settings/billing" },
        { title: "Matter", url: "/workspaces/workspace-1" },
      ],
      sources,
    );
    expect(sources.map(({ url }) => url)).toEqual([
      "/law/cz/statutes/civil-code",
    ]);
  });

  test.each(BUSINESS_REGISTRY_SLUGS)(
    "preserves the company identity through nested source deduplication for %s",
    (registry) => {
      const sources: ExternalSourceEntry[] = [];
      const source = {
        registry,
        id: "27082440",
        name: "Alza.cz a.s.",
        registryUrl: "https://example.org/company/27082440",
      };
      collectExternalSources(
        {
          hit: {
            ...source,
            details: {
              company: { name: source.name, registryUrl: source.registryUrl },
            },
          },
        },
        sources,
      );
      const deduplicated = dedupeExternalSources(sources);
      expect(sources.length).toBeGreaterThan(1);
      expect(deduplicated).toHaveLength(1);
      expect(deduplicated.at(0)?.businessRegistry).toEqual({
        registry,
        companyId: source.id,
      });
    },
  );
  test("extracts a search-hit source from JSON wrapped in MCP text content", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(externalMcpSearchResponseFixture, sources);

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      provider: "ES/ConstitutionalCourt",
      title: "SENTENCIA 105/2022, de 13 de septiembre",
      url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068",
    });
    expect(sources.at(0)?.snippet).toContain(
      "El Pleno del Tribunal Constitucional",
    );
    expect(sources.at(0)?.text).toBeUndefined();
  });

  test("extracts a source from JSON fenced as an untrusted connector result", () => {
    const payload = JSON.stringify({
      title: "Decision 105/2022",
      url: "https://registry.example/decisions/105-2022",
    });
    const fenced = `External connector result (connector "registry", tool "search").\n${UNTRUSTED_CONTENT_OPEN}\n${payload}\n${UNTRUSTED_CONTENT_CLOSE}`;
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(fenced, sources);

    expect(sources.map(({ title, url }) => ({ title, url }))).toEqual([
      {
        title: "Decision 105/2022",
        url: "https://registry.example/decisions/105-2022",
      },
    ]);
  });

  test("extracts full document text when get_document returns it", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(externalMcpGetDocumentResponseFixture, sources);

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      provider: "ES/ConstitutionalCourt",
      title: "SENTENCIA 105/2022, de 13 de septiembre",
      url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068",
    });
    expect(sources.at(0)?.text).toContain("EN NOMBRE DEL REY");
    expect(sources.at(0)?.snippet).toBeUndefined();
  });

  test("extracts full source data from a mocked cited assistant message", () => {
    const sources: ExternalSourceEntry[] = [];

    for (const part of externalMcpCitedAssistantMessageFixture.parts) {
      if ("output" in part) {
        collectExternalSources(part.output, sources);
      }
    }

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      provider: "ES/ConstitutionalCourt",
      title: "SENTENCIA 105/2022, de 13 de septiembre",
      url: "https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068",
    });
    expect(sources.at(0)?.text).toContain("recurso de amparo");
    expect(
      externalMcpCitedAssistantMessageFixture.parts
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join("\n"),
    ).toContain(
      "[SENTENCIA 105/2022, de 13 de septiembre](https://hj.tribunalconstitucional.es/HJ/es/Resolucion/Show/29068)",
    );
  });

  test("keeps the stella decision behind a case-law result's publisher URL", () => {
    const sources: ExternalSourceEntry[] = [];
    const decisionId = "a5a95801-7a7c-4c8b-98b3-7d17c8b8d7f9";

    collectExternalSources(
      {
        results: [
          {
            url: null,
            caseNumber: "23 Cdo 5068/2014",
            decisionId,
            sourceUrl: "https://example.org/decisions/23-cdo-5068-2014",
          },
        ],
      },
      sources,
    );

    expect(sources).toHaveLength(1);
    expect(sources.at(0)?.caseLawDecision).toEqual({
      caseNumber: "23 Cdo 5068/2014",
      decisionId,
    });
  });

  test("names no stella decision for a record without a stella decision id", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(
      {
        caseNumber: "23 Cdo 5068/2014",
        decisionId: "ECLI:CZ:NS:2017:23.CDO.5068.2014.1",
        sourceUrl: "https://example.org/decisions/23-cdo-5068-2014",
      },
      sources,
    );

    expect(sources).toHaveLength(1);
    expect(sources.at(0)?.caseLawDecision).toBeUndefined();
  });

  test("extracts decision text from generic sourceUrl plus nested texts output", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(
      {
        caseNumber: "23 Cdo 2351/2021",
        courtCode: "NS",
        sourceUrl: "https://mcp.slv.cz/ECLI:CZ:NS:2021:23.CDO.2351.2021.1",
        texts: {
          _combined:
            "=== justificationText ===\n23 Cdo 2351/2021-281\n\nČESKÁ REPUBLIKA\n\nROZSUDEK\n\nJMÉNEM REPUBLIKY",
        },
      },
      sources,
    );

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      provider: "NS",
      title: "23 Cdo 2351/2021",
      url: "https://mcp.slv.cz/ECLI:CZ:NS:2021:23.CDO.2351.2021.1",
    });
    expect(sources.at(0)?.text).toContain("ČESKÁ REPUBLIKA");
    expect(sources.at(0)?.text).toContain("JMÉNEM REPUBLIKY");
  });

  test("extracts ARES company output as an original external source link", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(
      {
        address: {
          textAddress: "Jankovcova 1522/53, Holešovice, 17000 Praha 7",
        },
        courtFile: {
          court: "Městský soud v Praze",
          insert: "8573",
          section: "B",
        },
        dateEstablished: "2003-08-26",
        ico: "27082440",
        legalForm: "Akciová společnost",
        name: "Alza.cz a.s.",
        registryUrl: "https://ares.gov.cz/ekonomicke-subjekty?ico=27082440",
        shareCapital: "2 000 000 Kč",
        statutoryBodies: [
          {
            members: [
              {
                name: "Aleš Zavoral",
                role: "předseda představenstva",
              },
            ],
            organName: "Představenstvo",
          },
        ],
      },
      sources,
    );

    expect(sources).toHaveLength(1);
    expect(sources.at(0)).toMatchObject({
      title: "Alza.cz a.s.",
      url: "https://ares.gov.cz/ekonomicke-subjekty?ico=27082440",
    });
    expect(sources.at(0)?.text).toBeUndefined();
    expect(sources.at(0)).not.toHaveProperty("data");
  });

  test("extracts unified business_registry_lookup ARES hits as original links", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(
      {
        type: "lookup",
        registry: "ares",
        hit: {
          registry: "ares",
          id: "27082440",
          name: "Alza.cz a.s.",
          legalForm: "Akciová společnost",
          address: {
            textAddress: "Jankovcova 1522/53, Holešovice, 17000 Praha 7",
          },
          registryUrl: "https://ares.gov.cz/ekonomicke-subjekty?ico=27082440",
          details: {
            registry: "ares",
            company: {
              actingClause:
                "Za společnost jednají vždy dva členové představenstva společně.",
              address: {
                textAddress: "Jankovcova 1522/53, Holešovice, 17000 Praha 7",
              },
              courtFile: {
                court: "Městský soud v Praze",
                insert: "8573",
                section: "B",
              },
              czNace: ["47910"],
              dateEstablished: "2003-08-26",
              dateRegistered: "2003-08-26",
              ico: "27082440",
              legalForm: "Akciová společnost",
              name: "Alza.cz a.s.",
              registryUrl:
                "https://ares.gov.cz/ekonomicke-subjekty?ico=27082440",
              shareCapital: "2 000 000 Kč",
              statutoryBodies: [
                {
                  members: [
                    {
                      address: "Praha",
                      name: "Aleš Zavoral",
                      role: "předseda představenstva",
                      since: "2010-01-01",
                    },
                  ],
                  organName: "Představenstvo",
                },
              ],
              status: null,
            },
          },
        },
      },
      sources,
    );

    expect(sources).toHaveLength(2);
    const source = sources.find(
      (item) =>
        item.url === "https://ares.gov.cz/ekonomicke-subjekty?ico=27082440",
    );
    expect(source).toMatchObject({
      businessRegistry: {
        companyId: "27082440",
        registry: "ares",
      },
      provider: "ares",
      title: "Alza.cz a.s.",
    });
    expect(source?.text).toBeUndefined();
    expect(source).not.toHaveProperty("data");

    expect(dedupeExternalSources(sources)).toEqual([
      expect.objectContaining({
        businessRegistry: {
          companyId: "27082440",
          registry: "ares",
        },
      }),
    ]);
  });

  test("does not treat unrecognized registry metadata as a company source", () => {
    const sources: ExternalSourceEntry[] = [];

    collectExternalSources(
      {
        id: "27082440",
        name: "Alza.cz a.s.",
        registry: "unknown-registry",
        registryUrl: "https://ares.gov.cz/ekonomicke-subjekty?ico=27082440",
      },
      sources,
    );

    expect(sources).toHaveLength(1);
    expect(sources.at(0)?.businessRegistry).toBeUndefined();
  });
});

const decisionPart = (output: unknown) => ({
  type: "tool-call" as const,
  id: "search",
  name: "infosoud_lookup_case" as const,
  state: "complete" as const,
  arguments: "{}",
  input: {},
  output,
});

describe("answer source classification", () => {
  test("classifies a persisted document by its canonical entity link", () => {
    const result = collectSourceChipEntries({
      appOrigins: APP_ORIGINS,
      sourceDocuments: [
        {
          entityId: "document-1",
          kind: "document",
          mimeType: "application/pdf",
          title: "Authority.pdf",
          workspaceId: "workspace-1",
        },
      ],
      parts: [
        {
          type: "text",
          content: "[Authority](#stella-entity=workspace-1:document-1)",
        },
      ],
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ relation: "cited", type: "document" }),
    ]);
  });

  test("splits cited and consulted decisions and merges duplicate hits", () => {
    const citedUrl = "https://example.test/cases/cited";
    const result = collectSourceChipEntries({
      appOrigins: APP_ORIGINS,
      parts: [
        decisionPart({
          results: [
            {
              url: citedUrl,
              caseNumber: "I. ÚS 1/26",
              court: "Ústavní soud",
              courtAbbreviation: "ÚS",
              decisionDate: "2026-01-01",
              summary: "A holding.",
            },
            {
              url: citedUrl,
              caseNumber: "I. ÚS 1/26",
              court: "Ústavní soud",
              courtAbbreviation: "ÚS",
              decisionDate: "2026-01-01",
            },
            {
              url: "https://example.test/cases/consulted",
              caseNumber: "2 Cdo 2/26",
              court: "Nejvyšší soud",
              courtAbbreviation: "NS",
            },
          ],
        }),
        { type: "text", content: `[cited](${citedUrl})` },
      ],
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(({ relation }) => relation)).toEqual([
      "cited",
      "consulted",
    ]);
    expect(result.entries.at(0)).toMatchObject({
      type: "case-law",
      caseLaw: { caseNumber: "I. ÚS 1/26", holding: "A holding." },
    });
  });

  test("keeps the date and id of an earlier hit for the same decision", () => {
    const url = "https://example.test/cases/repeated";
    const first = {
      url,
      caseNumber: "3 Cdo 3/26",
      court: "Nejvyšší soud",
      courtAbbreviation: "NS",
      decisionDate: "2026-01-02",
      decisionId: "a5a95801-7a7c-4c8b-98b3-7d17c8b8d7f9",
    };
    const later = {
      url,
      caseNumber: "3 Cdo 3/26",
      court: "Nejvyšší soud",
      courtAbbreviation: "NS",
    };
    const sources: ExternalSourceEntry[] = [];
    collectExternalSources({ results: [first, later] }, sources);
    expect(dedupeExternalSources(sources).at(0)?.caseLaw).toMatchObject({
      decisionDate: "2026-01-02",
      decisionId: first.decisionId,
    });
  });

  test("keeps a decision without court metadata as a generic source", () => {
    const decisionId = "a5a95801-7a7c-4c8b-98b3-7d17c8b8d7f9";
    const result = collectSourceChipEntries({
      appOrigins: APP_ORIGINS,
      parts: [
        decisionPart({
          url: "https://example.test/cases/missing",
          title: "Decision without citation metadata",
          decisionId,
          caseNumber: "I. ÚS 2/26",
        }),
      ],
    });
    expect(result.entries).toEqual([
      expect.objectContaining({
        type: "external",
        source: expect.objectContaining({
          caseLawDecision: { caseNumber: "I. ÚS 2/26", decisionId },
          title: "Decision without citation metadata",
        }),
      }),
    ]);
    expect(result.uniqueExternalSources).toHaveLength(1);
  });

  test("cites a source through a paragraph fragment of its URL", () => {
    const result = collectSourceChipEntries({
      appOrigins: APP_ORIGINS,
      parts: [
        decisionPart({
          url: "https://example.test/cases/cited",
          title: "Cited decision",
        }),
        {
          type: "text",
          content: "[bod 10](https://example.test/cases/cited#paragraph-10)",
        },
      ],
    });
    expect(result.entries.map(({ relation }) => relation)).toEqual(["cited"]);
  });

  test("cites an absolute app source through its root-relative route", () => {
    const result = collectSourceChipEntries({
      appOrigins: APP_ORIGINS,
      parts: [
        decisionPart({
          url: "https://app.test/law/cze/cases/ustavni-soud/i-us-1-26",
          title: "Decision by its app route",
        }),
        {
          type: "text",
          content: "[nález](/law/cze/cases/ustavni-soud/i-us-1-26#paragraph-3)",
        },
      ],
    });
    expect(result.entries.map(({ relation }) => relation)).toEqual(["cited"]);
  });

  test("cites an incomplete decision source by its canonical decision route", () => {
    const decisionId = "a5a95801-7a7c-4c8b-98b3-7d17c8b8d7f9";
    const route = createCaseLawDecisionPath(
      createCaseLawDecisionRouteParams({
        caseNumber: "I. ÚS 2/26",
        country: "CZE",
        court: "Ústavní soud",
        decisionId,
        language: null,
        languageAlternates: null,
        slug: null,
      }),
    );
    const result = collectSourceChipEntries({
      appOrigins: APP_ORIGINS,
      parts: [
        decisionPart({
          url: "https://example.test/cases/missing",
          title: "Decision without citation metadata",
          decisionId,
          caseNumber: "I. ÚS 2/26",
        }),
        { type: "text", content: `[nález](${route})` },
      ],
    });
    expect(result.entries.map(({ relation }) => relation)).toEqual(["cited"]);
  });

  test("keeps decision dates in the plain ISO form the row formats", () => {
    const result = collectSourceChipEntries({
      appOrigins: APP_ORIGINS,
      parts: [
        decisionPart({
          results: [
            {
              url: "https://example.test/cases/annotated",
              caseNumber: "I. ÚS 3/26",
              court: "Ústavní soud",
              courtAbbreviation: "ÚS",
              decisionDate: "2026-01-02[u-ca=iso8601]",
            },
          ],
        }),
      ],
    });
    const entry = result.entries.at(0);
    const decisionDate =
      entry?.type === "case-law" ? entry.caseLaw.decisionDate : undefined;
    expect(decisionDate).toBe("2026-01-02");
    expect(Number.isFinite(new Date(decisionDate ?? "").getTime())).toBe(true);
  });

  test("keeps a non-legal external URL whose path contains cases", () => {
    const url = "https://example.test/cases/customer-story";
    const result = collectSourceChipEntries({
      appOrigins: APP_ORIGINS,
      parts: [decisionPart({ url, title: "Customer story" })],
    });

    expect(result.entries).toEqual([
      expect.objectContaining({
        relation: "consulted",
        type: "external",
        source: expect.objectContaining({ title: "Customer story", url }),
      }),
    ]);
    expect(result.uniqueExternalSources).toHaveLength(1);
  });

  test.each([
    ["inline", "[authority](https://example.test/cases/cited)"],
    [
      "reference-style",
      "[authority][decision]\n\n[decision]: https://example.test/cases/cited",
    ],
    ["autolink", "<https://example.test/cases/cited>"],
  ])("classifies %s Markdown destinations as cited", (_kind, markdown) => {
    const url = "https://example.test/cases/cited";
    const result = collectSourceChipEntries({
      appOrigins: APP_ORIGINS,
      parts: [
        decisionPart({ url, title: "Cited source" }),
        { type: "text", content: markdown },
      ],
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ relation: "cited", type: "external" }),
    ]);
  });

  test("orders Czech court tiers from apex to first instance", () => {
    const codes = ["OS", "MS", "KS", "VS", "NSS", "NS", "ÚS"];
    expect(sortCourtTiers(codes.map(courtTierForSource))).toEqual([
      "constitutional",
      "supreme",
      "supreme",
      "regional",
      "regional",
      "other",
      "other",
    ]);
  });

  test.each<[string, string | undefined, CourtTierLabel]>([
    ["SCOTUS", "supreme", "supreme"],
    ["KSBR", "regional", "regional"],
    ["NS", undefined, "supreme"],
    ["NS", "invalid", "supreme"],
  ])(
    "uses the supplied %s court tier when valid and otherwise infers it",
    (courtAbbreviation, courtTier, expectedTier) => {
      const sources: ExternalSourceEntry[] = [];
      collectExternalSources(
        {
          url: `https://example.test/${courtAbbreviation}`,
          caseNumber: "1/2026",
          court: "Example court",
          courtAbbreviation,
          courtTier,
        },
        sources,
      );

      expect(sources.at(0)?.caseLaw?.tier).toBe(expectedTier);
    },
  );

  test("omits invalid decision dates during extraction", () => {
    const sources: ExternalSourceEntry[] = [];
    collectExternalSources(
      {
        url: "https://example.test/invalid-date",
        caseNumber: "1/2026",
        court: "Example court",
        courtAbbreviation: "SCOTUS",
        decisionDate: "not-a-date",
      },
      sources,
    );

    expect(sources.at(0)?.caseLaw?.decisionDate).toBeUndefined();
  });
});
