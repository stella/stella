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
 * keeps every fill module on the decision.
 *
 * The producer tables below are checked by the type checker: each producer's
 * result fields are either the fill's content or a diagnostic kind, so a
 * producer cannot grow a new outcome field that no kind accounts for.
 */
import { describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import type { SafeDb } from "@/api/db/safe-db";
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
  FillDiagnosticSources,
} from "@/api/lib/templates/template-fill-completion";
import * as templateFillService from "@/api/lib/templates/template-fill-service";
import type {
  FillTemplateResult,
  FillTemplateWithDocxResult,
} from "@/api/lib/templates/template-fill-service";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
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

const AI_ADAPTATION = {
  file: "content",
  adaptedPaths: "content",
} as const satisfies Record<keyof AdaptAiFieldsResult, ProducerRole>;

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

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
    "templateName" | "fileName" | "file" | "text"
  >,
  keyof FillDiagnosticSources
> = true;

describe("fill diagnostic producers", () => {
  test("every diagnostic kind has a producer the record reads", () => {
    const produced = new Set<string>(
      [RENDERED_FILL, AI_FIELDS, AI_CONDITIONS, AI_ADAPTATION].flatMap(
        (table) => Object.values(table),
      ),
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
    expect([SERVICE_TEXT_RESULT, SERVICE_DOCX_RESULT]).toEqual([true, true]);
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

/** The grading, restated independently of the owner's table: missing or
 *  misstated content blocks completion; legacy clause warnings and unused
 *  values do not. */
const oracleComplete = (sources: FillDiagnosticSources): boolean =>
  sources.unmatchedPlaceholders.length === 0 &&
  sources.aiFieldErrors.length === 0 &&
  sources.conditionDecisions.every(({ state }) => state === "decided") &&
  sources.structureErrors.length === 0;

const TEMPLATE_ID = "00000000-0000-4000-8000-000000000000";
const organizationId = toSafeId<"organization">("org_parity");
const userId = toSafeId<"user">("user_parity");

/** A transaction that keeps the rows written to it. */
const recordingDb = () => {
  const rows: Record<string, unknown>[] = [];
  const { scopedDb, safeDb } = createScopedDbMock({
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        rows.push(row);
        await Promise.resolve();
      },
    }),
  });
  return { rows, scopedDb, safeDb };
};

const recordedStatus = async (
  sources: FillDiagnosticSources,
): Promise<unknown> => {
  const { rows, scopedDb } = recordingDb();
  await scopedDb(
    async (tx) =>
      await recordTemplateFill({
        tx,
        templateId: toSafeId<"template">(TEMPLATE_ID),
        organizationId,
        userId,
        format: "docx",
        diagnostics: fillDiagnosticsOf(sources),
      }),
  );
  return rows.at(0)?.["status"];
};

const chatVerdict = async (
  sources: ServiceSources,
): Promise<{ completionStatus: unknown; recorded: unknown }> => {
  const { rows, scopedDb } = recordingDb();
  const fill = spyOn(
    templateFillService,
    "fillStoredTemplate",
  ).mockResolvedValue({ text: "Filled.", ...sources });
  try {
    const tools = createTemplateTools({
      orgAIConfig: null,
      managedAIResidency: "eu",
      scopedDb,
      safeDb: asTestRaw<SafeDb>(() => {
        throw new Error("no metered step runs in this test");
      }),
      organizationId,
      userId,
      thirdPartyBoundary: { type: "raw" },
    });
    const execute = asTestRaw<
      (input: unknown, options: unknown) => Promise<Record<string, unknown>>
    >(tools.fill_template.execute);
    const result = await execute({ templateId: TEMPLATE_ID, values: {} }, {});
    return {
      completionStatus: result["completionStatus"],
      recorded: rows.at(0)?.["status"],
    };
  } finally {
    fill.mockRestore();
  }
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
  const { scopedDb, safeDb } = createScopedDbMock({
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        rows.push(row);
        await Promise.resolve();
      },
    }),
  });
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
      fc.asyncProperty(fillSources, async (sources) => {
        const complete = oracleComplete(sources);
        const diagnostics = fillDiagnosticsOf(sources);
        expect(
          decideTemplateFillCompletion({ mode: "allow_partial", diagnostics })
            .type === "complete",
        ).toBe(complete);
        const status = complete ? "success" : "partial";
        expect(templateFillStatus(diagnostics)).toBe(status);
        expect(await recordedStatus(sources)).toBe(status);

        const chat = await chatVerdict(sources);
        expect(chat).toEqual({
          completionStatus: complete ? "complete" : "partial",
          recorded: status,
        });

        expect(await mcpVerdict(sources, "require_complete")).toEqual(
          complete
            ? { rejected: false, completionStatus: "complete" }
            : { rejected: true, completionStatus: undefined },
        );
        expect(await mcpVerdict(sources, "allow_partial")).toEqual({
          rejected: false,
          completionStatus: complete ? "complete" : "partial",
        });
      }),
      propertyConfig({ numRuns: 40 }),
    );
  });
});
