import type { CallToolResult } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
import { corpusCountryQuotas } from "@/api/mcp/compat-corpus";
import { LAW_COMPAT_TOOL_HANDLERS } from "@/api/mcp/compat-law-tools";
import { COMPAT_TOOL_HANDLERS } from "@/api/mcp/compat-tools";
import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { finalizeToolEgress } from "@/api/mcp/egress";
import type { McpToolHandler } from "@/api/mcp/tool-types";
import { serializeToolResult } from "@/api/mcp/tool-utils";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

/**
 * The OpenAI-compatible pair reaching the public legal corpus.
 *
 * Two audiences serve `search`/`fetch` under the same wire names: the default
 * one reads matters and the corpus, the law one reads the corpus alone. The
 * suite pins both, plus what the corpus gate being closed means, plus the
 * merged cursor's round trip.
 */

const WORKSPACE_ID = "00000000-0000-4000-8000-0000000a0001";
const ENTITY_ID = "00000000-0000-4000-8000-0000000e0001";
const DECISION_ID = "00000000-0000-4000-8000-0000000d0001";
const STATUTE_ELI = "/eli/cz/sb/2012/89";
const APP_BASE_URL = getAppBaseUrl();

const searchProviderSearchMock = mock();
const searchDecisionsHandlerMock = mock();
const searchLegislationHandlerMock = mock();
const readGatedDecisionMock = mock();
const resolveStatuteExpressionMock = mock();
const readPublicLegislationHandlerMock = mock();
const anonymizeTextFieldsMock = mock();

const emptyCatalogsByWorkspace = async ({
  workspaceIds,
}: {
  workspaceIds: readonly string[];
}) =>
  await Promise.resolve(
    new Map(workspaceIds.map((workspaceId) => [workspaceId, []])),
  );

const decisionHit = {
  decisionId: DECISION_ID,
  caseNumber: "29 Cdo 1234/2020",
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  languageAlternates: [],
  slug: "29-cdo-1234-2020",
  headline: "<b>promlčení</b>",
};

const statuteHit = {
  documentId: "00000000-0000-4000-8000-0000000f0001",
  country: "CZE",
  eli: STATUTE_ELI,
  slug: null,
  title: "Občanský zákoník",
  documentType: "act",
  effectiveDate: "2014-01-01",
  language: "cs",
  score: 1,
  headline: "<b>promlčení</b>",
  sourceUrl: "https://example.test/sb/2012/89",
  status: "in_force",
};

/**
 * `practiceJurisdictions` is the only jurisdiction signal this pair has. The
 * default fixture leaves the organization without one, which is what the
 * corpus reads as "every admitted country".
 */
const createContext = ({
  practiceJurisdictions = null,
  searchProvider = () => ({ search: searchProviderSearchMock }),
}: {
  practiceJurisdictions?: { countryCode: string; isPrimary: boolean }[] | null;
  searchProvider?: () => unknown;
} = {}): McpRequestContext => {
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      organizationSettings: {
        findFirst: async () =>
          await Promise.resolve(
            practiceJurisdictions === null
              ? undefined
              : { practiceJurisdictions },
          ),
      },
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          leftJoin: () => ({
            where: async () =>
              await Promise.resolve([
                {
                  entityId: ENTITY_ID,
                  workspaceId: WORKSPACE_ID,
                  fieldId: "field_1",
                },
              ]),
          }),
        }),
      }),
    }),
  });

  return {
    accessibleWorkspaceIds: [toSafeId<"workspace">(WORKSPACE_ID)],
    accessibleWorkspaceIdSet: new Set([WORKSPACE_ID]),
    accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, "active"]]),
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole: "owner",
    organizationId: toSafeId<"organization">("org_1"),
    recordAuditEvent: asTestRaw(mock(async () => undefined)),
    safeDb,
    scopedDb,
    testDependencies: {
      anonymizeTextFields: asTestRaw(anonymizeTextFieldsMock),
      getSearchReader: asTestRaw(searchProvider),
      loadAnonymizationAllowlistCanonicalsByWorkspace: asTestRaw(
        emptyCatalogsByWorkspace,
      ),
      loadAnonymizationGazetteerEntriesByWorkspace: asTestRaw(
        emptyCatalogsByWorkspace,
      ),
      readGatedDecisionWithDocument: asTestRaw(readGatedDecisionMock),
      readPublicLegislationHandler: asTestRaw(readPublicLegislationHandlerMock),
      resolveStatuteExpression: asTestRaw(resolveStatuteExpressionMock),
      searchDecisionsHandler: asTestRaw(searchDecisionsHandlerMock),
      searchLegislationHandler: asTestRaw(searchLegislationHandlerMock),
    },
    userId: toSafeId<"user">("user_1"),
  };
};

type CompatPayload = {
  results?: { id: string; title: string; url: string }[];
  nextCursor?: string | null;
  id?: string;
  title?: string;
  text?: string;
  url?: string;
  metadata?: { kind: string; workspaceId?: string };
  error?: { code: string; hint: string; issues?: { path: string }[] };
};

const run = async ({
  args,
  context,
  handler,
  mode = "default",
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  handler: McpToolHandler;
  mode?: McpMode;
}): Promise<CompatPayload> => {
  const response = await handler({ args, context });
  const result: CallToolResult = serializeToolResult(
    // The dispatch boundary forwards the context's anonymization seams to the
    // pipeline; this stands in for it so the suite exercises the same path.
    await finalizeToolEgress(
      { context, mode, response },
      {
        anonymizeTextFields: context.testDependencies?.anonymizeTextFields,
        loadAnonymizationAllowlistCanonicalsByWorkspace:
          context.testDependencies
            ?.loadAnonymizationAllowlistCanonicalsByWorkspace,
        loadAnonymizationGazetteerEntriesByWorkspace:
          context.testDependencies
            ?.loadAnonymizationGazetteerEntriesByWorkspace,
      },
    ),
  );
  const item = result.content.at(0);
  if (!item || item.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return asTestRaw<CompatPayload>(JSON.parse(item.text));
};

const withPublicLaw = async (
  { featurePublicLaw, isDev }: { featurePublicLaw: boolean; isDev: boolean },
  body: () => Promise<void>,
) => {
  const previousFeature = env.FEATURE_PUBLIC_LAW;
  const previousIsDev = env.isDev;
  env.FEATURE_PUBLIC_LAW = featurePublicLaw;
  env.isDev = isDev;
  try {
    await body();
  } finally {
    env.FEATURE_PUBLIC_LAW = previousFeature;
    env.isDev = previousIsDev;
  }
};

/** A context whose knowledge search provider is a tripwire, not a stub. */
const forbiddenSearchProvider = () => ({
  search: () => {
    throw new Error("the law audience must never search matter knowledge");
  },
});

beforeEach(() => {
  searchProviderSearchMock.mockReset();
  searchProviderSearchMock.mockResolvedValue({ hits: [], nextCursor: null });
  searchDecisionsHandlerMock.mockReset();
  searchDecisionsHandlerMock.mockResolvedValue({
    hits: [decisionHit],
    nextCursor: null,
  });
  searchLegislationHandlerMock.mockReset();
  searchLegislationHandlerMock.mockResolvedValue({
    items: [statuteHit],
    nextCursor: null,
  });
  readGatedDecisionMock.mockReset();
  readGatedDecisionMock.mockResolvedValue({
    ...decisionHit,
    id: DECISION_ID,
    citationsFrom: [],
    citationsTo: [],
    citationsNextCursor: null,
    documentAst: null,
    fulltext: "Rozsudek Nejvyššího soudu ze dne 1. 1. 2020.",
    source: { allowsDerivedAi: true },
  });
  resolveStatuteExpressionMock.mockReset();
  resolveStatuteExpressionMock.mockResolvedValue({
    type: "expression",
    id: "00000000-0000-4000-8000-0000000f0001",
  });
  readPublicLegislationHandlerMock.mockReset();
  readPublicLegislationHandlerMock.mockResolvedValue({
    ...statuteHit,
    id: "00000000-0000-4000-8000-0000000f0001",
    slug: "89-2012-obcansky-zakonik",
    documentAst: null,
    fulltext: "§ 1 Ustanovení tohoto zákona...",
    allowsDerivedAi: true,
    versionValidFrom: "2014-01-01",
    versionValidTo: null,
  });
  anonymizeTextFieldsMock.mockReset();
  anonymizeTextFieldsMock.mockImplementation(
    async ({ fields }: { fields: readonly string[] }) =>
      await Promise.resolve({
        entityCount: fields.length,
        fields: fields.map(() => "[REDACTED]"),
      }),
  );
});

const withCorpus = async (body: () => Promise<void>) =>
  await withPublicLaw({ featurePublicLaw: true, isDev: false }, body);

describe("the corpus page cap split across countries", () => {
  // Exhaustive rather than sampled: the domain is 1..cap for two caps that are
  // constants, so every case a deployment can reach is checked here.
  const CAPS = [
    LIMITS.mcpCompatDecisionPageSizeDefault,
    LIMITS.mcpCompatStatutePageSizeDefault,
  ];

  test("quotas sum to exactly the cap for every admissible country count", () => {
    for (const cap of CAPS) {
      for (let count = 1; count <= cap; count += 1) {
        const quotas = corpusCountryQuotas(
          cap,
          Array.from({ length: count }, (_, index) => index),
        );
        const total = quotas.reduce((sum, { limit }) => sum + limit, 0);
        expect(total, `cap ${cap} across ${count} countries`).toBe(cap);
      }
    }
  });

  test("no country is given a zero quota, and the shares differ by at most one", () => {
    for (const cap of CAPS) {
      for (let count = 1; count <= cap; count += 1) {
        const limits = corpusCountryQuotas(
          cap,
          Array.from({ length: count }, (_, index) => index),
        ).map(({ limit }) => limit);
        expect(
          Math.min(...limits),
          `cap ${cap} across ${count}`,
        ).toBeGreaterThan(0);
        // The remainder goes to the first countries in admitted order, so the
        // largest and smallest share can differ by one hit and no more.
        expect(Math.max(...limits) - Math.min(...limits)).toBeLessThanOrEqual(
          1,
        );
      }
    }
  });

  test("each admitted country list fits inside its page cap", () => {
    // The companion to the module-load assertion in compat-corpus.ts: a
    // country whose share floored to zero would need a deferred-page scheme
    // this pair does not have, so admitting one more country than the cap is
    // a change that has to move the cap with it.
    expect(PUBLIC_CASE_LAW_COUNTRIES.length).toBeLessThanOrEqual(
      LIMITS.mcpCompatDecisionPageSizeDefault,
    );
    expect(PUBLIC_LEGISLATION_COUNTRIES.length).toBeLessThanOrEqual(
      LIMITS.mcpCompatStatutePageSizeDefault,
    );
  });

  test("a page asks each corpus for no more than its cap", async () => {
    await withCorpus(async () => {
      await run({
        args: { query: "promlčení" },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.search,
      });

      // Every country's request carries its own quota, so what the corpus was
      // asked for in total is the cap and never more.
      const askedFor = (calls: readonly unknown[][]): number =>
        calls.reduce(
          (total, call) => total + asTestRaw<{ limit: number }>(call[0]).limit,
          0,
        );

      expect(askedFor(searchDecisionsHandlerMock.mock.calls)).toBe(
        LIMITS.mcpCompatDecisionPageSizeDefault,
      );
      expect(askedFor(searchLegislationHandlerMock.mock.calls)).toBe(
        LIMITS.mcpCompatStatutePageSizeDefault,
      );
    });
  });
});

describe("compat search reaching the public corpus", () => {
  test("the default surface returns matter hits, then decisions, then statutes", async () => {
    await withCorpus(async () => {
      searchProviderSearchMock.mockResolvedValue({
        hits: [
          { entityId: ENTITY_ID, workspaceId: WORKSPACE_ID, title: "SPA" },
        ],
        nextCursor: null,
      });

      const payload = await run({
        args: { query: "promlčení" },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.search,
      });

      expect(payload.results?.map(({ id }) => id)).toEqual([
        ENTITY_ID,
        `decision:${DECISION_ID}`,
        `statute:${STATUTE_ELI}`,
      ]);
      expect(payload.results?.at(1)).toEqual({
        id: `decision:${DECISION_ID}`,
        // The heading a `fetch` on this id answers with, minted once.
        title: "Nejvyšší soud 29 Cdo 1234/2020",
        url: `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/29-cdo-1234-2020`,
      });
      // A statute the corpus holds no slug for is addressed by the id form,
      // the same address the web routes it by.
      expect(payload.results?.at(2)?.url).toBe(
        `${APP_BASE_URL}/law/cze/statutes/89-2012-sb--AAAAAAAAQACAAAAAAA8AAQ`,
      );
    });
  });

  test("with the corpus gate closed, search is matter knowledge alone", async () => {
    await withPublicLaw({ featurePublicLaw: false, isDev: false }, async () => {
      searchProviderSearchMock.mockResolvedValue({
        hits: [
          { entityId: ENTITY_ID, workspaceId: WORKSPACE_ID, title: "SPA" },
        ],
        nextCursor: "provider-cursor",
      });

      const payload = await run({
        args: { query: "promlčení" },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.search,
      });

      expect(payload.results).toEqual([
        {
          id: ENTITY_ID,
          title: "SPA",
          url: `${APP_BASE_URL}/workspaces/${WORKSPACE_ID}/all/pdf?entity=${ENTITY_ID}&field=field_1`,
        },
      ]);
      // The provider's own cursor, verbatim: with no corpus to merge, nothing
      // wraps it.
      expect(payload.nextCursor).toBe("provider-cursor");
      expect(searchDecisionsHandlerMock).not.toHaveBeenCalled();
      expect(searchLegislationHandlerMock).not.toHaveBeenCalled();
    });
  });

  test("the organization's practice jurisdictions select the corpus countries", async () => {
    await withCorpus(async () => {
      await run({
        args: { query: "promlčení" },
        context: createContext({
          practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
        }),
        handler: COMPAT_TOOL_HANDLERS.search,
      });

      // The column stores alpha-2 and the corpus keys on alpha-3.
      expect(searchDecisionsHandlerMock.mock.calls.at(0)?.[0]).toMatchObject({
        country: "CZE",
      });
    });
  });

  test("an organization practising only outside the corpus gets no corpus hits", async () => {
    await withCorpus(async () => {
      const payload = await run({
        args: { query: "promlčení" },
        context: createContext({
          practiceJurisdictions: [{ countryCode: "JP", isPrimary: true }],
        }),
        handler: COMPAT_TOOL_HANDLERS.search,
      });

      expect(payload.results).toEqual([]);
      expect(searchDecisionsHandlerMock).not.toHaveBeenCalled();
    });
  });

  test("the merged cursor carries each source's own position and is read back", async () => {
    await withCorpus(async () => {
      searchProviderSearchMock.mockResolvedValue({
        hits: [],
        nextCursor: "matter-2",
      });
      searchDecisionsHandlerMock.mockResolvedValue({
        hits: [],
        nextCursor: "decisions-2",
      });
      searchLegislationHandlerMock.mockResolvedValue({
        items: [],
        nextCursor: null,
      });

      const first = await run({
        args: { query: "promlčení" },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.search,
      });
      expect(first.nextCursor).toBeTruthy();

      searchDecisionsHandlerMock.mockClear();
      searchLegislationHandlerMock.mockClear();
      await run({
        args: { query: "promlčení", cursor: first.nextCursor ?? "" },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.search,
      });

      expect(searchProviderSearchMock.mock.calls.at(-1)?.[0]).toMatchObject({
        cursor: "matter-2",
      });
      expect(searchDecisionsHandlerMock.mock.calls.at(0)?.[0]).toMatchObject({
        cursor: "decisions-2",
      });
      // Statutes ended on the first page, so they are not asked again.
      expect(searchLegislationHandlerMock).not.toHaveBeenCalled();
    });
  });

  test("an undecodable cursor is a validation_error naming the field", async () => {
    await withCorpus(async () => {
      const payload = await run({
        // Base64 of readable text: in the class this surface issues, so the
        // decoder is what refuses it rather than the made-up-cursor rule.
        args: { query: "promlčení", cursor: "bm90LWEtY3Vyc29y" },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.search,
      });

      expect(payload.error?.code).toBe("validation_error");
      expect(payload.error?.issues?.at(0)?.path).toBe("cursor");
    });
  });
});

describe("compat fetch reaching the public corpus", () => {
  test("a decision answers with its court, docket, text and app url", async () => {
    await withCorpus(async () => {
      const payload = await run({
        args: { id: `decision:${DECISION_ID}` },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.fetch,
      });

      expect(payload.id).toBe(`decision:${DECISION_ID}`);
      expect(payload.title).toBe("Nejvyšší soud 29 Cdo 1234/2020");
      expect(payload.text).toContain("Rozsudek");
      expect(payload.url).toBe(
        `${APP_BASE_URL}/law/cze/cases/nejvyssi-soud/29-cdo-1234-2020`,
      );
      expect(payload.metadata?.kind).toBe("decision");
      // `workspaceId` exists only on the branch that has one.
      expect(payload.metadata?.workspaceId).toBeUndefined();
    });
  });

  test("a statute answers with its name and current text", async () => {
    await withCorpus(async () => {
      const payload = await run({
        args: { id: `statute:${STATUTE_ELI}` },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.fetch,
      });

      expect(payload.title).toBe("Občanský zákoník");
      expect(payload.metadata?.kind).toBe("statute");
      expect(payload.url).toBe(
        `${APP_BASE_URL}/law/cze/statutes/89-2012-obcansky-zakonik`,
      );
    });
  });

  test("a corpus id refuses with feature_disabled while the gate is closed", async () => {
    await withPublicLaw({ featurePublicLaw: false, isDev: false }, async () => {
      const payload = await run({
        args: { id: `decision:${DECISION_ID}` },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.fetch,
      });

      expect(payload.error?.code).toBe("feature_disabled");
      expect(payload.error?.hint).toContain("FEATURE_PUBLIC_LAW");
    });
  });

  test("a malformed id is a validation_error whose hint names search", async () => {
    await withCorpus(async () => {
      const payload = await run({
        args: { id: "29 Cdo 1234/2020" },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.fetch,
      });

      expect(payload.error?.code).toBe("validation_error");
      expect(payload.error?.issues?.at(0)?.path).toBe("id");
      expect(payload.error?.hint).toContain("search");
    });
  });

  test("a wording the licence withholds refuses rather than answering empty", async () => {
    await withCorpus(async () => {
      readGatedDecisionMock.mockResolvedValue({
        ...decisionHit,
        id: DECISION_ID,
        citationsFrom: [],
        citationsTo: [],
        citationsNextCursor: null,
        documentAst: null,
        fulltext: "Rozsudek",
        source: { allowsDerivedAi: false },
      });

      const payload = await run({
        args: { id: `decision:${DECISION_ID}` },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.fetch,
      });

      expect(payload.error?.code).toBe("permission_denied");
      expect(payload.error?.hint).toContain("/law/cze/cases/");
    });
  });
});

describe("the law audience reaches no matter data", () => {
  test("its search never asks the knowledge provider and runs no matter query", async () => {
    await withCorpus(async () => {
      const context = createContext({
        searchProvider: forbiddenSearchProvider,
      });

      const payload = await run({
        args: { query: "promlčení" },
        context,
        handler: LAW_COMPAT_TOOL_HANDLERS.search,
        mode: "law",
      });

      expect(payload.results?.map(({ id }) => id)).toEqual([
        `decision:${DECISION_ID}`,
        `statute:${STATUTE_ELI}`,
      ]);
      // The only query the audience may run is the organization's own
      // jurisdiction settings; nothing reads extractedContent.
      expect(searchProviderSearchMock).not.toHaveBeenCalled();
    });
  });

  test("its fetch refuses a bare document uuid at the schema", async () => {
    await withCorpus(async () => {
      const payload = await run({
        args: { id: ENTITY_ID },
        context: createContext({ searchProvider: forbiddenSearchProvider }),
        handler: LAW_COMPAT_TOOL_HANDLERS.fetch,
        mode: "law",
      });

      expect(payload.error?.code).toBe("validation_error");
      expect(payload.error?.issues?.at(0)?.path).toBe("id");
      expect(searchProviderSearchMock).not.toHaveBeenCalled();
    });
  });

  test("its fetch reads a decision without touching matter content", async () => {
    await withCorpus(async () => {
      const payload = await run({
        args: { id: `decision:${DECISION_ID}` },
        context: createContext({ searchProvider: forbiddenSearchProvider }),
        handler: LAW_COMPAT_TOOL_HANDLERS.fetch,
        mode: "law",
      });

      expect(payload.metadata?.kind).toBe("decision");
      expect(payload.metadata?.workspaceId).toBeUndefined();
      expect(searchProviderSearchMock).not.toHaveBeenCalled();
    });
  });
});

describe("the anonymized audience", () => {
  test("anonymizes matter titles and leaves corpus hits as written", async () => {
    await withCorpus(async () => {
      searchProviderSearchMock.mockResolvedValue({
        hits: [
          {
            entityId: ENTITY_ID,
            workspaceId: WORKSPACE_ID,
            title: "John Smith SPA",
          },
        ],
        nextCursor: null,
      });

      const payload = await run({
        args: { query: "promlčení" },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.search,
        mode: "anonymized",
      });

      expect(payload.results?.at(0)?.title).toBe("[REDACTED]");
      // Published law carries no tenant attribution to redact, so the court
      // and docket a citation needs survive.
      expect(payload.results?.at(1)?.title).toBe(
        "Nejvyšší soud 29 Cdo 1234/2020",
      );
      expect(payload.results?.at(2)?.title).toBe("Občanský zákoník");
      // Exactly one field was handed to the redactor: the matter title.
      expect(anonymizeTextFieldsMock.mock.calls.at(0)?.[0]).toMatchObject({
        fields: ["John Smith SPA"],
      });
    });
  });

  test("leaves a fetched decision's text unredacted", async () => {
    await withCorpus(async () => {
      const payload = await run({
        args: { id: `decision:${DECISION_ID}` },
        context: createContext(),
        handler: COMPAT_TOOL_HANDLERS.fetch,
        mode: "anonymized",
      });

      expect(payload.text).toContain("Rozsudek");
      expect(payload.metadata?.kind).toBe("decision");
      expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
    });
  });
});
