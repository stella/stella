import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { BUILT_IN_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract";
import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import {
  SEARCH_PAGINATION_COMPLETE,
  countedSearchTotal,
  SEARCH_TOTAL_TYPE,
} from "@stll/api-contract/search";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { readGatedDecisionWithDocument } from "@/api/handlers/case-law/decisions/get-deferred-document";
import type { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import { decisionSampleForPrompt } from "@/api/handlers/case-law/research/columns-suggest-prompt";
import { buildActiveDecisionSection } from "@/api/handlers/chat/chat-prompt";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import type { ChatTools } from "@/api/handlers/chat/tools/chat-tools";
import {
  createChatCodeModeSurface,
  chatScriptReadToolNames,
} from "@/api/handlers/chat/tools/execute/chat-code-mode";
import { registerSandboxTestHygiene } from "@/api/handlers/chat/tools/execute/sandbox/sandbox-test-hygiene";
import { toSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { buildSuggestPromptUserMessage } from "@/api/lib/properties/column-prompt-suggestion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { buildMcpContextFromChat } from "./mcp-chat-context";
import {
  READ_TOOL_REF_FIELD_MAP,
  type RegistryReadToolName,
} from "./ref-field-map";
import { runRegistryReadTool } from "./run-registry-tool";
import { runRegistryWriteTool } from "./run-registry-write-tool";

registerSandboxTestHygiene();

const MARKER = "decision-text-fixture-7c41e9";
const DECISION_ID = toSafeId<"caseLawDecision">(
  "00000000-0000-4000-8000-000000000001",
);
const CASE_NUMBER = "1 Test 1/2026";
type Probe =
  | { readonly type: "probe"; readonly args: Record<string, unknown> }
  | { readonly type: "no-corpus-text"; readonly reason: string }
  | { readonly type: "registry-adapter" }
  | { readonly type: "unavailable"; readonly reason: string }
  | {
      readonly type: "refusal";
      readonly args: Record<string, unknown>;
      readonly code: "permission_denied";
    };
const noCorpusText = (reason: string) =>
  ({ type: "no-corpus-text", reason }) as const;
const probe = (args: Record<string, unknown>) =>
  ({ type: "probe", args }) as const;
const TENANT = "reads caller records and documents";
const CATALOG = "reads tool or skill metadata";
const LEGISLATION = "reads legislation";
const EXTERNAL = "reads external pages and registries";
const PRESENTATION = "returns caller-authored presentation or interaction data";
const PROBES = {
  add_comment: noCorpusText(TENANT),
  "ask-user": noCorpusText(PRESENTATION),
  boe_find_related_laws: noCorpusText(LEGISLATION),
  boe_get_law: noCorpusText(LEGISLATION),
  boe_get_law_block: noCorpusText(LEGISLATION),
  boe_get_law_structure: noCorpusText(LEGISLATION),
  boe_search_legislation: noCorpusText(LEGISLATION),
  borme_get_summary: noCorpusText(EXTERNAL),
  business_registry_lookup: noCorpusText(EXTERNAL),
  case_law_coverage: noCorpusText("returns aggregate corpus counts"),
  check_counterparty: noCorpusText(EXTERNAL),
  configure_template_fields: noCorpusText(TENANT),
  counterparty_check: noCorpusText(EXTERNAL),
  "create-current-skill-resource": noCorpusText(TENANT),
  "create-document": noCorpusText(TENANT),
  create_matter_document: noCorpusText(TENANT),
  create_reader_annotation: {
    type: "refusal",
    args: {
      target_type: "decision",
      target_id: DECISION_ID,
      mark: { kind: "highlight" },
      passages: [{ anchor: "a-1", quote: MARKER }],
    },
    code: "permission_denied",
  },
  create_template: noCorpusText(TENANT),
  delete_clause: noCorpusText(TENANT),
  delete_contact: noCorpusText(TENANT),
  delete_document: noCorpusText(TENANT),
  delete_matter: noCorpusText(TENANT),
  delete_reader_annotation: noCorpusText(TENANT),
  delete_task: noCorpusText(TENANT),
  delete_time_entry: noCorpusText(TENANT),
  describe_capability: noCorpusText(CATALOG),
  describe_template: noCorpusText(TENANT),
  discover_tools: noCorpusText(CATALOG),
  execute_typescript: { type: "registry-adapter" },
  "expand-chat-history": noCorpusText(TENANT),
  fetch: noCorpusText(TENANT),
  fetch_url: noCorpusText(EXTERNAL),
  fill_template: noCorpusText(TENANT),
  find_text: noCorpusText(TENANT),
  get_document_outline: noCorpusText(TENANT),
  get_usage: noCorpusText(TENANT),
  infosoud_lookup_case: noCorpusText(EXTERNAL),
  link_matter_contact: noCorpusText(TENANT),
  list_audit_log: noCorpusText(TENANT),
  list_capabilities: noCorpusText(CATALOG),
  list_clauses: noCorpusText(TENANT),
  list_contacts: noCorpusText(TENANT),
  list_documents: noCorpusText(TENANT),
  list_invoices: noCorpusText(TENANT),
  list_matters: noCorpusText(TENANT),
  list_playbooks: noCorpusText(TENANT),
  list_properties: noCorpusText(TENANT),
  list_reader_annotations: {
    type: "refusal",
    args: { target_type: "decision", target_id: DECISION_ID },
    code: "permission_denied",
  },
  list_stories: noCorpusText(TENANT),
  list_tasks: noCorpusText(TENANT),
  list_templates: noCorpusText(TENANT),
  list_time_entries: noCorpusText(TENANT),
  "load-skill": noCorpusText(CATALOG),
  lookup_business_registry: noCorpusText(EXTERNAL),
  lookup_case_law: probe({ country: "CZE", identifiers: [CASE_NUMBER] }),
  manage_organization: noCorpusText(TENANT),
  prepare_feedback: noCorpusText(TENANT),
  preview_template_conditions: noCorpusText(TENANT),
  "read-skill-resource": noCorpusText(CATALOG),
  read_capability: {
    type: "unavailable",
    reason: "capability dispatch is not projectable in chat",
  },
  read_case_law_citations: probe({
    decision_id: DECISION_ID,
    direction: "cites",
  }),
  read_case_law_decision: probe({ decision_ids: [DECISION_ID], full: true }),
  read_changes: noCorpusText(TENANT),
  read_comments: noCorpusText(TENANT),
  read_contact: noCorpusText(TENANT),
  read_content_across_matters: noCorpusText(TENANT),
  read_document: noCorpusText(TENANT),
  read_provision_history: noCorpusText(LEGISLATION),
  read_section: noCorpusText(TENANT),
  read_statute: noCorpusText(LEGISLATION),
  read_statute_provisions: noCorpusText(LEGISLATION),
  read_story: noCorpusText(TENANT),
  remember: noCorpusText(TENANT),
  reply_comment: noCorpusText(TENANT),
  resolve_comment: noCorpusText(TENANT),
  resolve_rate: noCorpusText(TENANT),
  review_folder_consistency: noCorpusText(TENANT),
  run_playbook: noCorpusText(TENANT),
  save_clause: noCorpusText(TENANT),
  save_contact: noCorpusText(TENANT),
  save_document: noCorpusText(TENANT),
  save_matter: noCorpusText(TENANT),
  save_playbook: noCorpusText(TENANT),
  save_task: noCorpusText(TENANT),
  save_time_entry: noCorpusText(TENANT),
  search: noCorpusText(TENANT),
  "search-all-past-chats": noCorpusText(TENANT),
  "search-chat-history": noCorpusText(TENANT),
  "search-past-chats": noCorpusText(TENANT),
  search_across_matters: noCorpusText(TENANT),
  search_boe_legislation: noCorpusText(LEGISLATION),
  search_case_law: probe({ country: "CZE", queries: ["test"] }),
  search_legislation: noCorpusText(LEGISLATION),
  set_field_value: noCorpusText(TENANT),
  set_practice_jurisdictions: noCorpusText(TENANT),
  show_in_document: noCorpusText(TENANT),
  show_visual: noCorpusText(PRESENTATION),
  spawn_subagents: { type: "registry-adapter" },
  suggest_changes: noCorpusText(TENANT),
  suggest_template_fields: noCorpusText(TENANT),
  "update-current-skill-body": noCorpusText(TENANT),
  "update-current-skill-resource": noCorpusText(TENANT),
  "update-entity-fields": noCorpusText(TENANT),
  update_reader_annotation: noCorpusText(
    "returns caller-authored comment fields",
  ),
  "use-browser": noCorpusText(EXTERNAL),
  web_search: noCorpusText(EXTERNAL),
} as const satisfies Record<
  | keyof ChatTools
  | RegistryReadToolName
  | keyof typeof BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  Probe
>;

const searchFixture = {
  paginationOutcome: SEARCH_PAGINATION_COMPLETE,
  facets: null,
  hits: [
    {
      anchorId: null,
      createdAt: "2026-01-01",
      courtTier: "supreme",
      caseNumber: CASE_NUMBER,
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      citationAuthority: 0,
      citationCount: 0,
      country: "CZE",
      court: "Court",
      courtAbbreviation: null,
      decisionDate: "2026-01-01",
      decisionId: DECISION_ID,
      decisionType: "judgment",
      ecli: null,
      identifiers: [
        { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: CASE_NUMBER },
      ],
      headline: MARKER,
      textWithheldReason: "source_licence",
      headnote: { type: "present", text: MARKER, truncated: false },
      language: "cs",
      languageAlternates: [],
      matchingPassages: 1,
      slug: "test-decision",
      sourceUrl: "https://example.test/decision",
    },
  ],
  nextCursor: null,
  total: countedSearchTotal(SEARCH_TOTAL_TYPE.EXACT, 1),
  queryUsed: "test",
  warnings: [],
} satisfies Awaited<ReturnType<typeof searchDecisionsHandler>>;
const readFixture = {
  hasDocument: true,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  id: DECISION_ID,
  resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
  caseNumber: CASE_NUMBER,
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  citationsFrom: [],
  citationsTo: [],
  citationsNextCursor: null,
  country: "CZE",
  court: "Court",
  courtAbbreviation: null,
  courtTier: null,
  decisionDate: "2026-01-01",
  decisionType: "judgment",
  documentAst: null,
  documentAstSource: null,
  projectionDigest: null,
  documentUrl: "https://example.test/document",
  ecli: null,
  identifiers: [
    { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: CASE_NUMBER },
  ],
  fulltext: MARKER,
  judges: [],
  headnote: { type: "present", text: MARKER, truncated: false },
  sections: null,
  language: "cs",
  languageGroupKey: null,
  languageAlternates: [],
  metadata: {},
  textFields: {
    abstract: { type: "present", text: MARKER },
    headnote: { type: "present", text: MARKER },
    legalSentence: { type: "present", text: MARKER },
    summary: { type: "present", text: MARKER },
  },
  slug: "test-decision",
  source: {
    id: toSafeId<"caseLawSource">("00000000-0000-4000-8000-000000000002"),
    name: "Source",
    adapterKey: "test",
    allowsDerivedAi: false,
  },
  sourceUrl: "https://example.test/decision",
  sourceAttributionUrl: "https://example.test/decision",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
} satisfies Awaited<ReturnType<typeof readGatedDecisionWithDocument>>;
const unusedScopedDb: ScopedDb = async () =>
  panic("This fixture does not read tenant data");
const context = (onAnnotationTarget?: () => void) =>
  buildMcpContextFromChat({
    memberRole: sessionMemberRole("owner"),
    organizationId: toSafeId<"organization">("org_1"),
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
    safeDb: toSafeDbMock(unusedScopedDb),
    scopedDb: unusedScopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [],
      pinnedIds: [],
    }),
    testDependencies: {
      resolveAnnotationTarget: async () => {
        onAnnotationTarget?.();
        return { status: "withheld" };
      },
      searchDecisionsHandler: async () => searchFixture,
      lookupDecisionsByIdentity: async () => [
        {
          caseNumber: CASE_NUMBER,
          caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          country: "CZE",
          court: "Court",
          courtAbbreviation: null,
          decisionDate: "2026-01-01",
          ecli: null,
          id: DECISION_ID,
          identifiers: [
            { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: CASE_NUMBER },
          ],
          language: "cs",
          languageAlternates: [],
          slug: "test-decision",
        },
      ],
      readGatedDecisionWithDocument: async () => readFixture,
      readGatedDecisionCitationDigest: async () => null,
      readsSharedPublicLawCorpus: () => false,
      readGatedDecisionCitations: async () => ({
        type: "page",
        page: {
          items: [
            {
              id: toSafeId<"caseLawCitation">(
                "00000000-0000-4000-8000-000000000003",
              ),
              citationText: null,
              textWithheldReason: "source_licence",
              sectionIndex: null,
              treatment: "unclassified",
              decision: null,
              passage: null,
            },
          ],
          nextCursor: null,
        },
      }),
    },
  });

test("chat tool decisions cover the complete built-in and script catalogs", () => {
  const declared = new Set(Object.keys(PROBES));
  const expected = new Set([
    ...Object.keys(BUILT_IN_CHAT_TOOL_POLICY_KINDS),
    ...Object.keys(READ_TOOL_REF_FIELD_MAP),
  ]);
  expect([...declared].toSorted()).toEqual([...expected].toSorted());
  for (const name of chatScriptReadToolNames()) {
    expect(declared.has(name), name).toBe(true);
  }
  expect(READ_TOOL_REF_FIELD_MAP.read_capability.chatProjectable).toBe(false);
  expect(chatScriptReadToolNames()).not.toContain("read_capability");
});

test("chat registry results preserve decision text policy", async () => {
  const exercised: string[] = [];
  for (const name of chatScriptReadToolNames()) {
    const entry = PROBES[name];
    if (entry.type !== "probe" && entry.type !== "refusal") {
      continue;
    }
    let annotationReads = 0;
    const result = await runRegistryReadTool({
      toolName: name,
      args: entry.args,
      context: context(() => {
        annotationReads += 1;
      }),
      refRegistry: createChatRefRegistry(),
    });
    if (entry.type === "refusal") {
      expect(Result.isError(result), name).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.message).toContain(entry.code);
        expect(result.error.message).not.toContain(MARKER);
      }
      expect(annotationReads).toBe(1);
      exercised.push(name);
      continue;
    }
    expect(Result.isOk(result), name).toBe(true);
    const payload = JSON.stringify(result.unwrap());
    expect(payload, name).not.toContain(MARKER);
    if (name !== "read_case_law_citations") {
      expect(payload).toContain(CASE_NUMBER);
    }
    if (name === "search_case_law" || name === "read_case_law_citations") {
      expect(payload).toContain("source_licence");
    }
    exercised.push(name);
  }
  expect(exercised.toSorted()).toEqual(
    [
      "search_case_law",
      "lookup_case_law",
      "read_case_law_decision",
      "read_case_law_citations",
      "list_reader_annotations",
    ].toSorted(),
  );
});

test("active decision prompts preserve decision text policy", async () => {
  const descriptor = {
    license: "restricted",
    attribution: null,
    allowsRedistribution: true,
    allowsDerivedAi: false,
  };
  const row = {
    id: DECISION_ID,
    country: "CZE",
    caseNumber: CASE_NUMBER,
    fulltext: MARKER,
    source: { descriptor },
  };
  const tx = asTestRaw<CaseLawPublicReadTransaction>({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                id: DECISION_ID,
                country: "CZE",
                descriptor,
                published: true,
                absorption: null,
              },
            ],
          }),
        }),
      }),
    }),
    query: { caseLawDecisions: { findFirst: async () => row } },
  });
  const read = async <T>(
    fn: (transaction: CaseLawPublicReadTransaction) => Promise<T>,
  ) => await fn(tx);
  const safeDb: SafeDb = () => panic("This fixture does not read tenant data");
  const result = await buildActiveDecisionSection({
    activeDecision: { decisionId: DECISION_ID },
    caseLawDb: Object.assign(read, caseLawPublicReadDb),
    safeDb,
    organizationId: undefined,
    userId: undefined,
  });
  expect(result.unwrap()).toContain(CASE_NUMBER);
  expect(result.unwrap()).not.toContain(MARKER);
});

test("column suggestion prompts preserve decision text policy", () => {
  const sample = decisionSampleForPrompt({
    caseNumber: CASE_NUMBER,
    court: "Court",
    decisionDate: "2026-01-01",
    headnote: { type: "present", text: MARKER, truncated: false },
    textWithheldReason: "source_licence",
  });
  const prompt = buildSuggestPromptUserMessage({
    name: "Outcome",
    instruction: "Refine",
    contentType: "text",
    options: undefined,
    currentPrompt: undefined,
    context: {
      kind: "case-law",
      country: "CZE",
      query: "test",
      filters: {
        court: undefined,
        dateFrom: undefined,
        dateTo: undefined,
        decisionType: undefined,
        language: undefined,
      },
      samples: [sample],
    },
  });
  expect(prompt).toContain(CASE_NUMBER);
  expect(prompt).not.toContain(MARKER);
});

test("script search results preserve decision text policy", async () => {
  const codeMode = createChatCodeModeSurface({
    concurrencyKey: "text-invariants",
    documentedReads: ["search_case_law"],
    runReadTool: async (toolName, args) =>
      await runRegistryReadTool({
        toolName,
        args,
        context: context(),
        refRegistry: createChatRefRegistry(),
      }),
  });
  const execute = codeMode.tool.execute ?? panic("Script execution is missing");
  const output = await execute({
    typescriptCode:
      'return await external_search_case_law({ country: "CZE", queries: ["test"] });',
  });
  const serialized = JSON.stringify(output);
  expect(serialized).toContain(CASE_NUMBER);
  expect(serialized).toContain("source_licence");
  expect(serialized).not.toContain(MARKER);
});

test("chat search results retain available excerpts", async () => {
  const requestContext = context();
  requestContext.testDependencies = {
    ...requestContext.testDependencies,
    searchDecisionsHandler: async () => ({
      ...searchFixture,
      hits: searchFixture.hits.map((hit) => ({
        ...hit,
        textWithheldReason: null,
      })),
    }),
  };
  const result = await runRegistryReadTool({
    toolName: "search_case_law",
    args: { country: "CZE", queries: ["test"] },
    context: requestContext,
    refRegistry: createChatRefRegistry(),
  });
  const serialized = JSON.stringify(result.unwrap());
  expect(serialized).toContain(CASE_NUMBER);
  expect(serialized).toContain(MARKER);
});

test("chat annotation writes preserve decision text policy", async () => {
  let annotationReads = 0;
  const entry = PROBES.create_reader_annotation;
  const result = await runRegistryWriteTool({
    toolName: "create_reader_annotation",
    args: entry.args,
    context: context(() => {
      annotationReads += 1;
    }),
    refRegistry: createChatRefRegistry(),
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toContain(entry.code);
    expect(result.error.message).not.toContain(MARKER);
  }
  expect(annotationReads).toBe(1);
});
