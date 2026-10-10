/**
 * Every surface that reports a template fill gives the same completion verdict
 * for the same diagnostics, and that verdict is the owner's decision.
 *
 * The surfaces are driven through their real code with the fill result
 * substituted: the recorded fill row (REST fills and downloads, chat and MCP
 * through `recordTemplateFill`), the chat `fill_template` tool, and the MCP
 * `fill_template` tool under both completion modes. Report exports read the
 * same decision under `require_complete`; their DB-backed path is covered in
 * report-export-queue.integration.test.ts, and the `fill-diagnostics` lint
 * keeps every fill module on the decision. Unrestored anonymization
 * placeholders reach the record only from the chat tool's anonymizing
 * boundary, so the chat surface is driven through one.
 *
 * The producer tables below are checked by the type checker: each producer's
 * result fields are either the fill's content or a diagnostic kind, so a
 * producer cannot grow a new outcome field that no kind accounts for.
 */
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { propertyConfig } from "@stll/property-testing";

import type { SafeDb } from "@/api/db/safe-db";
import { createChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { createTemplateTools } from "@/api/handlers/chat/tools/template-tools";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { ClauseDirectiveWarning } from "@/api/lib/clauses/clause-directives";
import type { AdaptAiFieldsResult } from "@/api/lib/docx/adapt-ai-fields";
import type {
  ResolvedAiCondition,
  ResolvedAiConditions,
} from "@/api/lib/docx/resolve-ai-conditions";
import type {
  AiFieldError,
  ResolveAiFieldsResult,
} from "@/api/lib/docx/resolve-ai-fields";
import type { FillTemplateResult as RenderedFill } from "@/api/lib/docx/types";
import { recordTemplateFill } from "@/api/lib/templates/record-use";
import {
  decideTemplateFillCompletion,
  FILL_DIAGNOSTIC_KINDS,
  fillDiagnosticsOf,
  templateFillStatus,
} from "@/api/lib/templates/template-fill-completion";
import type {
  FillDiagnosticKind,
  FillDiagnostics,
  FillDiagnosticSources,
} from "@/api/lib/templates/template-fill-completion";
import type {
  FilledDocumentMember,
  FillTemplateResult,
  FillTemplateWithDocxResult,
} from "@/api/lib/templates/template-fill-service";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

// --- Producer accounting (type-level) ----------------------------------------

/** `content`: what the fill renders or carries forward, not an outcome.
 *  `conditionDecisions`: the raw condition outcomes `undecidedConditions` is
 *  read from. Every other role is a `FillDiagnostics` kind. */
type ProducerRole = FillDiagnosticKind | "conditionDecisions" | "content";

const RENDERED_FILL = {
  file: "content",
  unmatchedPlaceholders: "unmatchedPlaceholders",
  unusedValues: "unusedValues",
  structureErrors: "structureErrors",
} as const satisfies Record<keyof RenderedFill, ProducerRole>;

const AI_FIELDS = {
  values: "content",
  errors: "aiFieldErrors",
} as const satisfies Record<keyof ResolveAiFieldsResult, ProducerRole>;

const AI_CONDITIONS = {
  values: "content",
  conditions: "conditionDecisions",
} as const satisfies Record<keyof ResolvedAiConditions, ProducerRole>;

/** A field the model could not adapt fills with its stub as written: an AI
 *  field error (`generation-failed`), blocking like a failed draft. */
const AI_ADAPTATION = {
  file: "content",
  adaptedPaths: "content",
  failures: "aiFieldErrors",
} as const satisfies Record<keyof AdaptAiFieldsResult, ProducerRole>;

/** What the fill's caller observes around the service: the chat tool's
 *  anonymizing boundary reports values that kept a placeholder. */
type BoundaryDiagnostics = NonNullable<Parameters<typeof fillDiagnosticsOf>[1]>;
const FILL_BOUNDARY = {
  unrestoredFields: "unrestoredFields",
} as const satisfies Record<keyof BoundaryDiagnostics, ProducerRole>;

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// A producer's channel feeds the kind its table names, in that kind's shape.
const ADAPTATION_FAILURES_ARE_AI_FIELD_ERRORS: Equal<
  AdaptAiFieldsResult["failures"][number],
  FillDiagnostics["aiFieldErrors"][number]
> = true;

// Every kind is read from a service source or from the fill's boundary, and
// nothing else: a kind with neither has no producer the record reads.
const KINDS_HAVE_SOURCES: Equal<
  FillDiagnosticKind,
  | Exclude<keyof FillDiagnosticSources, "conditionDecisions">
  | "undecidedConditions"
  | keyof BoundaryDiagnostics
> = true;

type Filled<T> = Exclude<
  T,
  { error: string } | { requiredFieldsRejection: unknown }
>;

// The fill service's results carry exactly the sources the record is read
// from, beside their content: a new outcome field fails here until
// `FillDiagnosticSources` (and so the record) reads it.
const SERVICE_TEXT_RESULT: Equal<
  Exclude<keyof Filled<FillTemplateResult>, "text">,
  keyof FillDiagnosticSources
> = true;
const SERVICE_DOCX_RESULT: Equal<
  Exclude<
    keyof Filled<FillTemplateWithDocxResult>,
    FilledDocumentMember | "text"
  >,
  keyof FillDiagnosticSources
> = true;

describe("fill diagnostic producers", () => {
  test("every diagnostic kind has a producer the record reads", () => {
    const produced = new Set<string>(
      [
        RENDERED_FILL,
        AI_FIELDS,
        AI_CONDITIONS,
        AI_ADAPTATION,
        FILL_BOUNDARY,
      ].flatMap((table) => Object.values(table)),
    );
    // Clause warnings come from the service's clause patching, whose result
    // is the warning list itself; undecided conditions are read from the
    // condition decisions.
    produced.add("clauseWarnings");
    if (produced.has("conditionDecisions")) {
      produced.add("undecidedConditions");
    }
    expect(FILL_DIAGNOSTIC_KINDS.filter((kind) => !produced.has(kind))).toEqual(
      [],
    );
    expect([
      SERVICE_TEXT_RESULT,
      SERVICE_DOCX_RESULT,
      ADAPTATION_FAILURES_ARE_AI_FIELD_ERRORS,
      KINDS_HAVE_SOURCES,
    ]).toEqual([true, true, true, true]);
  });
});

// --- Surface parity (property) -----------------------------------------------

const word = fc.stringMatching(/^[a-z]{1,8}$/u);

const aiFieldError: fc.Arbitrary<AiFieldError> = fc.record({
  fieldPath: word,
  valuePath: word,
  itemIndex: fc.constant(null),
  reason: fc.constantFrom(
    "empty",
    "generation-failed",
    "interrupted",
    "truncated",
  ),
  message: word,
});

const conditionDecision: fc.Arbitrary<ResolvedAiCondition> = fc.oneof(
  fc.record({
    path: word,
    label: word,
    state: fc.constant("decided"),
    value: fc.boolean(),
    decidedBy: fc.constant("user"),
  }),
  fc.record({
    path: word,
    label: word,
    state: fc.constant("undecided"),
    reason: fc.constantFrom("no-backend", "below-floor", "failed"),
  }),
);

const clauseWarning: fc.Arbitrary<ClauseDirectiveWarning> = fc.record({
  code: fc.constant("CLAUSE_LEGACY_DIRECTIVES"),
  clauseName: word,
  version: fc.constant(1),
  message: word,
  issues: fc.constant([]),
});

const few = <T>(item: fc.Arbitrary<T>) => fc.array(item, { maxLength: 2 });

/** The sources as the fill service returns them (mutable lists). */
type ServiceSources = {
  -readonly [
    K in keyof FillDiagnosticSources
  ]: FillDiagnosticSources[K][number][];
};

const fillSources: fc.Arbitrary<ServiceSources> = fc.record({
  unmatchedPlaceholders: few(word),
  aiFieldErrors: few(aiFieldError),
  conditionDecisions: few(conditionDecision),
  clauseWarnings: few(clauseWarning),
  structureErrors: few(
    fc.record({
      message: word,
      paragraphIndex: fc.nat({ max: 20 }),
      directive: word,
    }),
  ),
  unusedValues: few(word),
});

/** Field paths whose value kept an anonymization placeholder (the chat
 *  boundary's observation), distinct and in the order the tool reports. */
const unrestoredPaths: fc.Arbitrary<string[]> = fc
  .uniqueArray(word, { maxLength: 2 })
  .map((paths) => paths.toSorted());

/** The grading, restated independently of the owner's table: missing or
 *  misstated content blocks completion (an AI draft or adaptation that
 *  failed, a value that kept a placeholder); legacy clause warnings and
 *  unused values do not. */
const oracleComplete = (
  sources: FillDiagnosticSources,
  unrestoredFields: readonly string[],
): boolean =>
  sources.unmatchedPlaceholders.length === 0 &&
  sources.aiFieldErrors.length === 0 &&
  sources.conditionDecisions.every(({ state }) => state === "decided") &&
  sources.structureErrors.length === 0 &&
  unrestoredFields.length === 0;

const TEMPLATE_ID = "00000000-0000-4000-8000-000000000000";
const organizationId = toSafeId<"organization">("org_parity");
const userId = toSafeId<"user">("user_parity");

/** A transaction that keeps the rows inserted into it and accepts the
 *  template use-count bump. */
const recordingTx = (rows: Record<string, unknown>[]) => ({
  insert: () => ({
    values: async (row: Record<string, unknown>) => {
      rows.push(row);
      await Promise.resolve();
    },
  }),
  update: () => ({
    set: () => ({
      where: async () => {
        await Promise.resolve();
      },
    }),
  }),
});

const recordingDb = () => {
  const rows: Record<string, unknown>[] = [];
  const { scopedDb, safeDb } = createScopedDbMock(recordingTx(rows));
  return { rows, scopedDb, safeDb };
};

/** The recorded status of a stored-template fill and of an uploaded one. */
const recordedStatus = async (
  sources: FillDiagnosticSources,
  unrestoredFields: readonly string[],
): Promise<unknown[]> => {
  const { rows, scopedDb } = recordingDb();
  const diagnostics = fillDiagnosticsOf(sources, { unrestoredFields });
  await scopedDb(async (tx) => {
    await recordTemplateFill({
      tx,
      templateId: toSafeId<"template">(TEMPLATE_ID),
      organizationId,
      userId,
      format: "docx",
      diagnostics,
    });
    await recordTemplateFill({
      tx,
      templateId: null,
      organizationId,
      userId,
      format: "docx",
      diagnostics,
    });
  });
  return rows.map((row) => row["status"]);
};

/** A chat turn sent anonymized: a value holding a placeholder the turn never
 *  sent cannot be restored. */
const anonymizedBoundary = () =>
  createChatThirdPartyBoundary({
    anonymizeFields: async ({ fields }: { fields: string[] }) =>
      await Promise.resolve(
        Result.ok({ entityCount: 0, fields, redactionMap: new Map() }),
      ),
    anonymizationScopeId: "workspace-parity",
    organizationId,
    scopedDb: createScopedDbMock({}).scopedDb,
    sendMode: CHAT_SEND_MODE.anonymized,
    threadRestorations: [],
  });

const chatVerdict = async (
  sources: ServiceSources,
  unrestoredFields: readonly string[],
): Promise<{
  completionStatus: unknown;
  recorded: unknown;
  unrestoredFields: unknown;
}> => {
  const { rows, scopedDb } = recordingDb();
  const tools = createTemplateTools({
    orgAIConfig: null,
    managedAIResidency: "eu",
    scopedDb,
    safeDb: asTestRaw<SafeDb>(() => {
      throw new Error("no metered step runs in this test");
    }),
    organizationId,
    modelAdmission: testModelAdmission(organizationId),
    userId,
    thirdPartyBoundary: anonymizedBoundary(),
    dependencies: {
      fillStoredTemplate: async () =>
        await Promise.resolve({ text: "Filled.", ...sources }),
    },
  });
  const execute = asTestRaw<
    (input: unknown, options: unknown) => Promise<Record<string, unknown>>
  >(tools.fill_template.execute);
  // Each unrestored path holds a placeholder the turn never sent; the
  // others hold plain text.
  const values = Object.fromEntries([
    ["plain_value", "Plain text"],
    ...unrestoredFields.map((path, index) => [path, `[PERSON_${index + 1}]`]),
  ]);
  const result = await execute({ templateId: TEMPLATE_ID, values }, {});
  return {
    completionStatus: result["completionStatus"],
    recorded: rows.at(0)?.["status"],
    unrestoredFields: result["unrestoredFields"],
  };
};

const mcpContext = (
  sources: ServiceSources,
  rows: Record<string, unknown>[],
): McpRequestContext => {
  const filled = async () =>
    await Promise.resolve({
      templateName: "Template",
      fileName: "template.docx",
      file: testDocxFile(Buffer.from("PK")),
      text: "Filled.",
      ...sources,
    });
  const { scopedDb, safeDb } = createScopedDbMock(recordingTx(rows));
  return {
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    grantedScopes: [],
    memberRole: "owner",
    organizationId,
    recordAuditEvent: asTestRaw<AuditRecorder>(async () => {
      await Promise.resolve();
    }),
    safeDb,
    scopedDb,
    userId,
    userEmail: "parity@example.test",
    testDependencies: {
      fillStoredTemplateWithText: filled,
      fillStoredTemplateWithTextStrict: filled,
    },
  };
};

const mcpVerdict = async (
  sources: ServiceSources,
  mode: "require_complete" | "allow_partial",
): Promise<{ rejected: boolean; completionStatus: unknown }> => {
  const rows: Record<string, unknown>[] = [];
  const result = await handleMcpToolCall({
    args: {
      template_id: TEMPLATE_ID,
      values: {},
      completion_mode: mode,
      allow_unused_values: true,
      // The text output mode re-reads the document; the docx mode hands the
      // substituted bytes back as they are.
      output_mode: "docx",
    },
    context: mcpContext(sources, rows),
    toolName: "fill_template",
  });
  const item = result.content.at(0);
  const payload: unknown =
    item?.type === "text" ? JSON.parse(item.text) : undefined;
  return {
    rejected: result.isError === true,
    completionStatus:
      typeof payload === "object" && payload !== null
        ? Reflect.get(payload, "completionStatus")
        : undefined,
  };
};

describe("fill completion parity across surfaces", () => {
  test("every surface reports the owner's verdict", async () => {
    await fc.assert(
      fc.asyncProperty(
        fillSources,
        unrestoredPaths,
        async (sources, unrestoredFields) => {
          const complete = oracleComplete(sources, unrestoredFields);
          const diagnostics = fillDiagnosticsOf(sources, { unrestoredFields });
          expect(
            decideTemplateFillCompletion({ mode: "allow_partial", diagnostics })
              .type === "complete",
          ).toBe(complete);
          const status = complete ? "success" : "partial";
          expect(templateFillStatus(diagnostics)).toBe(status);
          expect(await recordedStatus(sources, unrestoredFields)).toEqual([
            status,
            status,
          ]);

          const chat = await chatVerdict(sources, unrestoredFields);
          expect(chat).toEqual({
            completionStatus: complete ? "complete" : "partial",
            recorded: status,
            unrestoredFields:
              unrestoredFields.length === 0 ? undefined : unrestoredFields,
          });

          // MCP fills run without an anonymizing boundary: nothing is left
          // unrestored, so the verdict is the sources' alone.
          const mcpComplete = oracleComplete(sources, []);
          expect(await mcpVerdict(sources, "require_complete")).toEqual(
            mcpComplete
              ? { rejected: false, completionStatus: "complete" }
              : { rejected: true, completionStatus: undefined },
          );
          expect(await mcpVerdict(sources, "allow_partial")).toEqual({
            rejected: false,
            completionStatus: mcpComplete ? "complete" : "partial",
          });
        },
      ),
      propertyConfig({ numRuns: 40 }),
    );
  });
});
