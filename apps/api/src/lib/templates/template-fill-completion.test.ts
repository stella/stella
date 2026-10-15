import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_UNDECIDED_REASONS } from "@stll/api-contract/ai-decision-provider";
import { propertyConfig } from "@stll/property-testing";

import {
  clauseDirectiveWarningSchema,
  type ClauseDirectiveWarning,
} from "@/api/lib/clauses/clause-directives";
import type { ResolvedAiCondition } from "@/api/lib/docx/resolve-ai-conditions";
import type { AiFieldError } from "@/api/lib/docx/resolve-ai-fields";
import type { TemplateStructureError } from "@/api/lib/docx/types";
import {
  decideTemplateFillCompletion,
  describeFillShortfall,
  FILL_DIAGNOSTIC_GRADES,
  FILL_DIAGNOSTIC_KINDS,
  fillDiagnosticsOf,
  fillShortfallIssues,
  TEMPLATE_FILL_COMPLETION_MODES,
  templateFillStatus,
} from "@/api/lib/templates/template-fill-completion";
import type {
  FillDiagnosticGrades,
  FillDiagnostics,
  UndecidedAiCondition,
} from "@/api/lib/templates/template-fill-completion";

const aiFieldErrorArbitrary: fc.Arbitrary<AiFieldError> = fc.record({
  fieldPath: fc.string({ minLength: 1 }),
  valuePath: fc.string({ minLength: 1 }),
  itemIndex: fc.option(fc.integer({ min: 1, max: 20 }), { nil: null }),
  reason: fc.constantFrom<AiFieldError["reason"]>(
    "empty",
    "generation-failed",
    "interrupted",
    "truncated",
  ),
  message: fc.string({ minLength: 1 }),
});

const undecidedConditionArbitrary: fc.Arbitrary<UndecidedAiCondition> =
  fc.record({
    path: fc.string({ minLength: 1 }),
    label: fc.string({ minLength: 1 }),
    state: fc.constant("undecided"),
    reason: fc.constantFrom(...DECISION_UNDECIDED_REASONS),
  });

const clauseWarningArbitrary: fc.Arbitrary<ClauseDirectiveWarning> = fc.record({
  code: fc.constantFrom(...clauseDirectiveWarningSchema.entries.code.options),
  clauseName: fc.string({ minLength: 1 }),
  version: fc.option(fc.integer({ min: 1, max: 50 }), { nil: null }),
  message: fc.string({ minLength: 1 }),
  issues: fc.array(fc.record({ path: fc.string(), message: fc.string() }), {
    maxLength: 3,
  }),
});

const structureErrorArbitrary: fc.Arbitrary<TemplateStructureError> = fc.record(
  {
    message: fc.string({ minLength: 1 }),
    paragraphIndex: fc.integer({ min: 0, max: 500 }),
    directive: fc.string({ minLength: 1 }),
  },
);

const diagnosticsArbitrary: fc.Arbitrary<FillDiagnostics> = fc.record({
  unmatchedPlaceholders: fc.array(fc.string({ minLength: 1 }), {
    maxLength: 5,
  }),
  aiFieldErrors: fc.array(aiFieldErrorArbitrary, { maxLength: 3 }),
  undecidedConditions: fc.array(undecidedConditionArbitrary, { maxLength: 3 }),
  clauseWarnings: fc.array(clauseWarningArbitrary, { maxLength: 3 }),
  structureErrors: fc.array(structureErrorArbitrary, { maxLength: 3 }),
  unusedValues: fc.array(fc.string({ minLength: 1 }), { maxLength: 5 }),
  unrestoredFields: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
});

const EMPTY_DIAGNOSTICS: FillDiagnostics = {
  unmatchedPlaceholders: [],
  aiFieldErrors: [],
  undecidedConditions: [],
  clauseWarnings: [],
  structureErrors: [],
  unusedValues: [],
  unrestoredFields: [],
};

/** Independent oracle: a kind blocks when any entry it carries grades
 *  blocking. Written against the table by hand rather than through the
 *  decision's own filter. */
const hasBlockingEntry = (diagnostics: FillDiagnostics): boolean =>
  diagnostics.unmatchedPlaceholders.length > 0 ||
  diagnostics.aiFieldErrors.length > 0 ||
  diagnostics.undecidedConditions.length > 0 ||
  diagnostics.structureErrors.length > 0 ||
  diagnostics.unrestoredFields.length > 0;

const undecided = (
  reason: UndecidedAiCondition["reason"],
): UndecidedAiCondition => ({
  path: "is_consumer",
  label: "Consumer contract",
  state: "undecided",
  reason,
});

describe("template fill completion policy", () => {
  test("a fill is complete iff every diagnostic it carries is non-blocking", () => {
    fc.assert(
      fc.property(
        diagnosticsArbitrary,
        fc.constantFrom(...TEMPLATE_FILL_COMPLETION_MODES),
        (diagnostics, mode) => {
          const decision = decideTemplateFillCompletion({ mode, diagnostics });

          expect(decision.diagnostics).toEqual(diagnostics);
          if (!hasBlockingEntry(diagnostics)) {
            expect(decision.type).toBe("complete");
            expect(templateFillStatus(diagnostics)).toBe("success");
            return;
          }

          expect(decision.type).toBe(
            mode === "allow_partial" ? "accepted_partial" : "rejected_partial",
          );
          expect(templateFillStatus(diagnostics)).toBe("partial");
          if (decision.type === "complete") {
            throw new Error("a blocking diagnostic cannot be complete");
          }
          // Every blocking kind is named, and only those.
          expect([...decision.blockingKinds]).toEqual(
            FILL_DIAGNOSTIC_KINDS.filter(
              (kind) =>
                kind !== "unusedValues" &&
                kind !== "clauseWarnings" &&
                diagnostics[kind].length > 0,
            ),
          );
          // The informational channels never enter the shortfall.
          expect(decision.blocking.unusedValues).toEqual([]);
          expect(decision.blocking.clauseWarnings).toEqual([]);
          expect(decision.blocking.undecidedConditions).toEqual(
            diagnostics.undecidedConditions,
          );
        },
      ),
      propertyConfig(),
    );
  });

  test("unused values alone keep a fill complete", () => {
    const decision = decideTemplateFillCompletion({
      mode: "require_complete",
      diagnostics: { ...EMPTY_DIAGNOSTICS, unusedValues: ["extra_key"] },
    });
    expect(decision.type).toBe("complete");
  });

  test("a failed AI draft alone makes a fill incomplete", () => {
    const aiFieldErrors: AiFieldError[] = [
      {
        fieldPath: "scope",
        valuePath: "scope",
        itemIndex: null,
        reason: "truncated",
        message: "The model reached its output limit before finishing.",
      },
    ];
    const diagnostics = { ...EMPTY_DIAGNOSTICS, aiFieldErrors };

    expect(
      decideTemplateFillCompletion({ mode: "require_complete", diagnostics })
        .type,
    ).toBe("rejected_partial");
    expect(
      decideTemplateFillCompletion({ mode: "allow_partial", diagnostics }).type,
    ).toBe("accepted_partial");
  });

  for (const reason of ["failed", "no-backend"] as const) {
    test(`an AI condition left undecided (${reason}) alone makes a fill incomplete`, () => {
      const diagnostics = {
        ...EMPTY_DIAGNOSTICS,
        undecidedConditions: [undecided(reason)],
      };
      const rejected = decideTemplateFillCompletion({
        mode: "require_complete",
        diagnostics,
      });
      expect(rejected.type).toBe("rejected_partial");
      expect(templateFillStatus(diagnostics)).toBe("partial");
      if (rejected.type === "complete") {
        throw new Error("expected a shortfall");
      }
      expect(rejected.blockingKinds).toEqual(["undecidedConditions"]);
      expect(describeFillShortfall(rejected.blocking)).toBe(
        `AI-decided conditions left undecided: is_consumer (${reason})`,
      );
      expect(fillShortfallIssues(rejected.blocking)).toEqual([
        {
          path: "values.is_consumer",
          message: `AI-decided condition "Consumer contract" was left undecided (${reason}); supply true or false for it.`,
        },
      ]);
    });
  }

  test("a stored clause kept with literal legacy directives fills as before, reported but not blocking", () => {
    const diagnostics = {
      ...EMPTY_DIAGNOSTICS,
      clauseWarnings: [
        {
          code: "CLAUSE_LEGACY_DIRECTIVES",
          clauseName: "Terms",
          version: 3,
          slotKey: "@clause:Terms",
          message:
            "Clause Terms version 3 retains literal legacy directive markers.",
          issues: [],
        } satisfies ClauseDirectiveWarning,
      ],
    };
    const decision = decideTemplateFillCompletion({
      mode: "require_complete",
      diagnostics,
    });
    // Never refused, and still carried in the diagnostics it reports.
    expect(decision).toEqual({ type: "complete", diagnostics });
    expect(templateFillStatus(diagnostics)).toBe("success");
    expect(fillShortfallIssues(diagnostics)).toEqual([
      {
        path: "clauses.@clause:Terms",
        message:
          "Clause Terms version 3 retains literal legacy directive markers.",
      },
    ]);
  });

  test("a directive the renderer could not apply makes a fill incomplete", () => {
    const decision = decideTemplateFillCompletion({
      mode: "require_complete",
      diagnostics: {
        ...EMPTY_DIAGNOSTICS,
        structureErrors: [
          {
            message: "Unclosed inline {% if %}",
            paragraphIndex: 4,
            directive: "{% if oops %}",
          },
        ],
      },
    });
    expect(decision.type).toBe("rejected_partial");
  });

  test("a value still holding an anonymization placeholder alone makes a fill incomplete", () => {
    const diagnostics = {
      ...EMPTY_DIAGNOSTICS,
      unrestoredFields: ["party.name"],
    };
    const rejected = decideTemplateFillCompletion({
      mode: "require_complete",
      diagnostics,
    });
    expect(templateFillStatus(diagnostics)).toBe("partial");
    if (rejected.type !== "rejected_partial") {
      throw new Error("expected a rejected shortfall");
    }
    expect(rejected.blockingKinds).toEqual(["unrestoredFields"]);
    expect(fillShortfallIssues(rejected.blocking)).toEqual([
      {
        path: "values.party.name",
        message:
          "The value still holds an anonymization placeholder, so the document carries the placeholder instead of the real value; supply the real value.",
      },
    ]);
  });

  test("fillDiagnosticsOf carries the fields a boundary could not restore", () => {
    expect(
      fillDiagnosticsOf(
        {
          unmatchedPlaceholders: [],
          aiFieldErrors: [],
          conditionDecisions: [],
          clauseWarnings: [],
          structureErrors: [],
          unusedValues: [],
        },
        { unrestoredFields: ["party.name"] },
      ),
    ).toEqual({ ...EMPTY_DIAGNOSTICS, unrestoredFields: ["party.name"] });
  });

  test("fillDiagnosticsOf reads undecided conditions out of the fill's decisions", () => {
    const conditionDecisions: ResolvedAiCondition[] = [
      {
        path: "is_signed",
        label: "Signed",
        state: "decided",
        value: true,
        decidedBy: "user",
      },
      undecided("failed"),
    ];
    expect(
      fillDiagnosticsOf({
        unmatchedPlaceholders: [],
        aiFieldErrors: [],
        conditionDecisions,
        clauseWarnings: [],
        structureErrors: [],
        unusedValues: ["x"],
      }),
    ).toEqual({
      ...EMPTY_DIAGNOSTICS,
      undecidedConditions: [undecided("failed")],
      unusedValues: ["x"],
    });
  });

  test("every diagnostic kind carries a grade (type-level)", () => {
    // Removing a kind's grade does not typecheck: a new channel cannot land
    // ungraded. The directive below fails the build if it ever stops erroring.
    const { undecidedConditions: _dropped, ...ungraded } =
      FILL_DIAGNOSTIC_GRADES;
    // @ts-expect-error -- undecidedConditions has no grade
    const incomplete: FillDiagnosticGrades = ungraded;
    expect(Object.keys(incomplete)).not.toContain("undecidedConditions");
    expect(Object.keys(FILL_DIAGNOSTIC_GRADES).toSorted()).toEqual(
      [...FILL_DIAGNOSTIC_KINDS].toSorted(),
    );
  });
});
