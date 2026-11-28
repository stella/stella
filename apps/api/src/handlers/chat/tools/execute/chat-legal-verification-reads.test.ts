import { panic } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import { DECISION_BODY_TEXT_SOURCE } from "@stll/api-contract/case-law-body-source";
import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import { noDecisionReviewFound } from "@stll/api-contract/case-law-reviews";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { createTestState } from "@stll/test-state";

import type { ScopedDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { registerSandboxTestHygiene } from "@/api/handlers/chat/tools/execute/sandbox/sandbox-test-hygiene";
import { buildMcpContextFromChat } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { readDecisionTextMetadata } from "@/api/lib/case-law/decision-text";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isRecord } from "@/api/lib/type-guards";
import type { McpRequestResources } from "@/api/mcp/context";
import type { ReadCaseLawDecisionSuccess } from "@/api/mcp/public-law-handlers";
import {
  getStaticMcpToolHandler,
  getStaticMcpToolOutputContract,
} from "@/api/mcp/static-tool-definitions";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import { serializeToolResult } from "@/api/mcp/tool-utils";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import {
  buildChatCodeMode,
  CHAT_CODE_MODE_SYSTEM_PROMPT,
  chatCodeModeSystemPrompt,
  chatScriptReadToolNames,
} from "./chat-code-mode";
import { DOCUMENTABLE_CHAT_READ_NAMES } from "./documented-chat-reads";

/**
 * The citation checks an MCP client runs (verify a quote, resolve a docket or
 * a statute citation) are chat script reads. A chat script that calls one gets
 * exactly the payload an MCP client receives as `structuredContent`: every id
 * in these envelopes is a public corpus id, so the chat projection changes
 * nothing.
 */

registerSandboxTestHygiene();

const testState = createTestState({ file: import.meta.path, config: env });

beforeEach(() => {
  testState.setConfig("FEATURE_PUBLIC_LAW", true);
});

const LEGAL_VERIFICATION_READS = [
  "verify_quote",
  "resolve_case_law_decision",
  "resolve_law_citation",
] as const satisfies readonly RegistryReadToolName[];

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const decisionId = createSafeId<"caseLawDecision">();

const storedDecision = () =>
  ({
    id: decisionId,
    documentPending: false,
    documentReadFailed: false,
    documentUnavailable: false,
    textWithheldReason: null,
    textIncompleteReason: null,
    hasDocument: true,
    resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
    caseNumber: "1 Test 1/2026",
    caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    court: "Nejvyšší soud",
    courtId: null,
    courtAbbreviation: "NS",
    courtTier: "supreme",
    country: "CZE",
    language: "cs",
    languageGroupKey: null,
    languageAlternates: [],
    decisionDate: null,
    decisionType: null,
    citationCount: 0,
    slug: null,
    ecli: null,
    identifiers: [
      { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "1 Test 1/2026" },
    ],
    documentAst: null,
    projectionDigest: null,
    documentAstSource: null,
    fulltext: "Soud návrh zamítl pro opožděnost podání.",
    sections: null,
    bodySource: { textSource: DECISION_BODY_TEXT_SOURCE.HOST },
    sourceUrl: "https://example.test/decision",
    sourceAttributionUrl: "https://example.test/decision",
    documentUrl: "https://example.test/decision.pdf",
    ...readDecisionTextMetadata({}),
    headnote: readDecisionTextMetadata({}).textFields.headnote,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    source: {
      id: createSafeId<"caseLawSource">(),
      name: "Test source",
      adapterKey: "cz-ns",
      allowsDerivedAi: true,
    },
    judges: [],
    citationsFrom: [],
    citationsTo: [],
    citationsNextCursor: null,
    caseFile: { items: [], nextCursor: null, limit: 50 },
    extractionWarnings: [],
    appealReviews: noDecisionReviewFound(),
    sourceLanguages: [],
  }) satisfies ReadCaseLawDecisionSuccess;

const decisionReaderUrl = `https://example.test/case-law/${decisionId}`;

const RESOLVED_DECISION = {
  status: "resolved",
  document: {
    kind: "decision",
    decisionId,
    identifier: "1 Test 1/2026",
    country: "CZE",
    caseNumber: "1 Test 1/2026",
    ecli: null,
    court: "Nejvyšší soud",
    decisionDate: "2026-01-01",
    language: "cs",
    languageAlternates: [],
    readerUrl: decisionReaderUrl,
    text: { status: "readable", charCount: 41 },
    appealReviews: noDecisionReviewFound(),
  },
  otherCourtCandidates: [
    {
      decisionId: createSafeId<"caseLawDecision">(),
      identifier: "1 Co 1/2026",
      label: "Krajský soud v Brně, rozsudek, 2026-01-01",
      readerUrl: "https://example.test/case-law/other",
      court: "Krajský soud v Brně",
      decisionDate: "2026-01-01",
      decisionType: "rozsudek",
      subjectSummary: null,
    },
  ],
} satisfies LegalResolveResponse;

const RESOLVED_PROVISION = {
  status: "resolved",
  document: {
    kind: "provision",
    documentId: "00000000-0000-4000-8000-0000000d0042",
    eli: "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
    country: "CZE",
    title: "Občanský zákoník",
    section: "2910",
    readerUrl: "https://example.test/legislation/89-2012#par_2910",
    inForce: { from: "2014-01-01", to: null },
    versionStatus: "current",
    blocks: [
      {
        id: "par_2910-1",
        anchorId: "par_2910",
        text: "Škůdce, který vlastním zaviněním poruší povinnost stanovenou zákonem…",
      },
    ],
  },
} satisfies LegalResolveResponse;

type Fixture = {
  name: string;
  toolName: (typeof LEGAL_VERIFICATION_READS)[number];
  args: Record<string, unknown>;
  status: string;
  testDependencies: NonNullable<McpRequestResources["testDependencies"]>;
};

const quoteFixture = (
  name: string,
  text: string,
  status: string,
  read: ReadCaseLawDecisionSuccess = storedDecision(),
): Fixture => ({
  name,
  toolName: "verify_quote",
  args: { decision_id: decisionId, text },
  status,
  testDependencies: {
    readsSharedPublicLawCorpus: () => false,
    readGatedDecisionWithDocument: async () => await Promise.resolve(read),
  },
});

const resolveFixture = (
  name: string,
  toolName: Fixture["toolName"],
  response: LegalResolveResponse,
): Fixture => ({
  name,
  toolName,
  args:
    toolName === "resolve_case_law_decision"
      ? { country: "CZE", identifier: "1 Test 1/2026" }
      : {
          country: "CZE",
          source: { type: "citation", citation: "89/2012 Sb." },
          section: "2910",
        },
  status: response.status,
  testDependencies: {
    resolveDecision: async () => await Promise.resolve(response),
    resolveLawCitation: async () => await Promise.resolve(response),
  },
});

const FIXTURES: readonly Fixture[] = [
  quoteFixture("an exact quote", "Soud návrh zamítl", "exact"),
  quoteFixture(
    "an altered quote",
    "Soud návrh přijal pro opožděnost podání.",
    "fuzzy",
  ),
  quoteFixture("an absent quote", "Odvolání bylo zamítnuto", "not_found"),
  quoteFixture("withheld text", "Soud návrh zamítl", "cannot_verify", {
    ...storedDecision(),
    source: { ...storedDecision().source, allowsDerivedAi: false },
  }),
  resolveFixture("a docket", "resolve_case_law_decision", RESOLVED_DECISION),
  resolveFixture("an ambiguous docket", "resolve_case_law_decision", {
    status: "ambiguous",
    candidates: [
      {
        decisionId,
        identifier: "1 Test 1/2026",
        label: "Nejvyšší soud, rozsudek, 2026-01-01",
        readerUrl: decisionReaderUrl,
      },
    ],
  }),
  resolveFixture("an unpublished docket", "resolve_case_law_decision", {
    status: "not_found",
    reason: "no_exact_identity",
    coverage: {
      status: "read",
      asOf: "2026-11-01",
      sources: [
        {
          verdict: "not_published",
          source: "cz-ns",
          sourceName: "NS ČR",
          years: { from: 2026, to: 2026 },
        },
      ],
    },
  }),
  resolveFixture(
    "a statute citation",
    "resolve_law_citation",
    RESOLVED_PROVISION,
  ),
  resolveFixture("an unknown section", "resolve_law_citation", {
    status: "not_found",
    reason: "unknown_section",
  }),
  resolveFixture("an incomplete citation", "resolve_law_citation", {
    status: "incomplete_identifier",
    missing: ["section"],
  }),
];

const unusedScopedDb = asTestRaw<ScopedDb>(async () => {
  throw new Error("These reads answer from their test dependencies.");
});

let userCounter = 0;

const chatDeps = (
  testDependencies: NonNullable<McpRequestResources["testDependencies"]>,
) => {
  userCounter += 1;
  return {
    testDependencies,
    memberRole: sessionMemberRole("owner"),
    organizationId: toSafeId<"organization">("org_1"),
    safeDb: toSafeDbMock(unusedScopedDb),
    scopedDb: unusedScopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [toSafeId<"workspace">(WS_UUID)],
      pinnedIds: [],
    }),
    workspaceStatusById: new Map([[WS_UUID, "active" as const]]),
    userId: toSafeId<"user">(`user_${userCounter}`),
    userEmail: `user_${userCounter}@example.test`,
  };
};

/** What an MCP client receives as `structuredContent` for the same call. */
const mcpStructuredContent = async (fixture: Fixture): Promise<unknown> => {
  const handler =
    getStaticMcpToolHandler(fixture.toolName) ??
    panic(`${fixture.toolName} has no MCP handler`);
  const response = await handler({
    args: fixture.args,
    context: authorizedMcpContextForTest(
      buildMcpContextFromChat(chatDeps(fixture.testDependencies)),
    ),
  });
  if (isMcpEgressPlan(response)) {
    return panic(`${fixture.toolName} answers without an egress plan`);
  }
  const wire = serializeToolResult(
    response,
    getStaticMcpToolOutputContract(fixture.toolName),
    fixture.toolName,
  );
  expect(wire.isError).not.toBe(true);
  return wire.structuredContent;
};

/** What a chat script receives from `external_<tool>` for the same call. */
const chatScriptResult = async (fixture: Fixture): Promise<unknown> => {
  const codeMode = buildChatCodeMode({
    ...chatDeps(fixture.testDependencies),
    documentedReads: [],
    refRegistry: createChatRefRegistry(),
    toolDefectMemo: createChatToolDefectMemo(),
    scriptCallTools: () => ({
      directTools: ["execute_typescript", "discover_tools"],
      unavailableReasons: new Map<string, string>(),
    }),
  });
  const execute =
    codeMode.tool.execute ??
    expect.unreachable("execute_typescript has no execute");
  const output: unknown = await execute({
    typescriptCode: `return await external_${fixture.toolName}(${JSON.stringify(fixture.args)});`,
  });
  expect(output).toMatchObject({ success: true });
  return isRecord(output)
    ? output["result"]
    : panic("execute_typescript answered without a result");
};

describe("legal verification reads in a chat script", () => {
  test.each(
    FIXTURES.map((fixture) => [fixture.toolName, fixture.name, fixture]),
  )("%s on %s answers the MCP envelope", async (_toolName, _name, fixture) => {
    const mcp = await mcpStructuredContent(fixture);
    const chat = await chatScriptResult(fixture);

    expect(mcp).toMatchObject({ status: fixture.status });
    expect(chat).toEqual(mcp);
  });

  test("each is a lazy script read: named in the catalog, stubbed only on demand", async () => {
    const offered = chatScriptReadToolNames();
    const codeMode = buildChatCodeMode({
      ...chatDeps({}),
      documentedReads: [],
      refRegistry: createChatRefRegistry(),
      toolDefectMemo: createChatToolDefectMemo(),
      scriptCallTools: () => ({
        directTools: [],
        unavailableReasons: new Map<string, string>(),
      }),
    });
    const discover =
      codeMode.discoveryTool?.execute ??
      expect.unreachable("discover_tools has no execute");

    for (const toolName of LEGAL_VERIFICATION_READS) {
      expect(offered).toContain(toolName);
      expect(DOCUMENTABLE_CHAT_READ_NAMES).toContain(toolName);
      expect(CHAT_CODE_MODE_SYSTEM_PROMPT).toMatch(
        new RegExp(`^- external_${toolName} `, "mu"),
      );
      expect(CHAT_CODE_MODE_SYSTEM_PROMPT).not.toContain(
        `declare function external_${toolName}`,
      );
      expect(chatCodeModeSystemPrompt([toolName])).toContain(
        `declare function external_${toolName}`,
      );
      expect(
        JSON.stringify(await discover({ toolNames: [toolName] })),
      ).toContain("Returns:");
    }
  });
});
