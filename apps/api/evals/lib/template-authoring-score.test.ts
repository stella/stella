import { describe, expect, test } from "bun:test";

import type { AuthoredBlock, SaveAttempt } from "./template-authoring-score";
import {
  checkSourceFidelity,
  cleanRoundTrip,
  comparePaths,
  detectGrammarTraps,
  scoreAuthoringRun,
  scoreSyntaxQuiz,
} from "./template-authoring-score";

const paragraph = (text: string): AuthoredBlock => ({
  type: "paragraph",
  text,
});

const traps = (
  blocks: readonly AuthoredBlock[],
  overlay = [],
  booleanInputPaths: string[] = [],
) => detectGrammarTraps({ blocks, overlay, booleanInputPaths });

describe("detectGrammarTraps", () => {
  test("a correctly authored repeat trips nothing", () => {
    const counts = traps([
      paragraph("{{#each attorneys}}"),
      paragraph("{{attorneys.name}}, {{attorneys.role}}"),
      paragraph("{{/each}}"),
    ]);
    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
  });

  test("an item path without its array prefix is counted once per occurrence", () => {
    const counts = traps([
      paragraph("{{#each attorneys}}"),
      paragraph("{{name}} — {{role}}"),
      paragraph("{{/each}}"),
    ]);
    expect(counts.unprefixed_item_path).toBe(2);
    expect(counts.this_prefix).toBe(0);
  });

  test("a `this.` reference is its own trap, not an unprefixed path", () => {
    const counts = traps([
      paragraph("{{#each attorneys}}"),
      paragraph("{{this.name}}"),
      paragraph("{{/each}}"),
    ]);
    expect(counts.this_prefix).toBe(1);
    expect(counts.unprefixed_item_path).toBe(0);
  });

  test("`{{#endeach}}` is an unknown directive, `{{attorneys[0].name}}` a bracket index", () => {
    const counts = traps([
      paragraph("{{#each attorneys}}"),
      paragraph("{{attorneys[0].name}}"),
      paragraph("{{#endeach}}"),
    ]);
    expect(counts.unknown_directive).toBe(1);
    expect(counts.bracket_index).toBe(1);
  });

  test("a block marker sharing its paragraph with text is counted once for that paragraph", () => {
    const counts = traps([
      paragraph("{{#if penalty}}A penalty applies.{{/if}}"),
      paragraph("{{#each rows}}"),
      paragraph("{{rows.name}}"),
      paragraph("{{/each}}"),
    ]);
    expect(counts.block_marker_inline).toBe(1);
  });

  test("two block directives in one paragraph share it, even with no other text", () => {
    expect(
      traps([paragraph("{{#if penalty}}{{/if}}")]).block_marker_inline,
    ).toBe(1);
    expect(
      traps([
        paragraph("{{#if penalty}}"),
        paragraph("A penalty applies."),
        paragraph("{{/if}}"),
      ]).block_marker_inline,
    ).toBe(0);
  });

  test("per-language paths for one value collapse to a language_variant_path", () => {
    const counts = traps([
      paragraph("Podpisano {{signing_date_pl}}"),
      paragraph("Signed {{signing_date_en}}"),
      paragraph("{{company}} / {{company}}"),
    ]);
    expect(counts.language_variant_path).toBe(1);
  });

  test("a lookup on a leaf of another marker path is lookup_not_parent", () => {
    const blocks = [paragraph("{{company}}, {{company.krs}}")];
    expect(
      detectGrammarTraps({
        blocks,
        overlay: [{ path: "company.krs", lookup: { formats: [] } }],
        booleanInputPaths: [],
      }).lookup_not_parent,
    ).toBe(1);
    expect(
      detectGrammarTraps({
        blocks,
        overlay: [{ path: "company", lookup: { formats: [{ key: "krs" }] } }],
        booleanInputPaths: [],
      }).lookup_not_parent,
    ).toBe(0);
  });

  test("a lookup inside an {{#each}} keeps its dotted path without tripping", () => {
    expect(
      detectGrammarTraps({
        blocks: [
          paragraph("{{#each companies}}"),
          paragraph("{{companies.krs}}"),
          paragraph("{{/each}}"),
        ],
        overlay: [{ path: "companies.krs", lookup: { formats: [] } }],
        booleanInputPaths: [],
      }).lookup_not_parent,
    ).toBe(0);
  });

  test("a condition on a tick-box field, or one restating its own path, is condition_on_input", () => {
    expect(
      detectGrammarTraps({
        blocks: [paragraph("{{#if penalty}}")],
        overlay: [{ path: "penalty", condition: "penalty == true" }],
        booleanInputPaths: [],
      }).condition_on_input,
    ).toBe(1);
    expect(
      detectGrammarTraps({
        blocks: [paragraph("{{#if penalty}}")],
        overlay: [{ path: "penalty", condition: "amount > 0" }],
        booleanInputPaths: ["penalty"],
      }).condition_on_input,
    ).toBe(1);
    expect(
      detectGrammarTraps({
        blocks: [paragraph("{{#if has_penalty}}")],
        overlay: [{ path: "has_penalty", condition: "amount > 0" }],
        booleanInputPaths: [],
      }).condition_on_input,
    ).toBe(0);
  });
});

describe("checkSourceFidelity", () => {
  const preserved = ["DOHODA O MLČENLIVOSTI", "se řídí právem"];

  test("wording that survives around the markers passes, whitespace aside", () => {
    expect(
      checkSourceFidelity({
        authored: [
          "DOHODA   O MLČENLIVOSTI",
          "Tato dohoda se řídí\nprávem {{rozhodne_pravo}}.",
        ],
        preservedPhrases: preserved,
      }),
    ).toEqual([]);
  });

  test("a skeleton of bare markers reports every dropped phrase", () => {
    expect(
      checkSourceFidelity({
        authored: ["{{strana_a}}", "{{rozhodne_pravo}}"],
        preservedPhrases: preserved,
      }),
    ).toEqual(['dropped "DOHODA O MLČENLIVOSTI"', 'dropped "se řídí právem"']);
  });
});

describe("comparePaths", () => {
  test("reports what the brief asked for and what the model added", () => {
    expect(comparePaths(["a", "b"], ["b", "c"])).toEqual({
      missing: ["a"],
      extra: ["c"],
    });
  });
});

describe("scoreAuthoringRun", () => {
  type SavedAttempt = Extract<SaveAttempt, { status: "saved" }>;

  const savedAttempt = (): SavedAttempt => ({
    status: "saved",
    paths: { missing: [], extra: [] },
    traps: detectGrammarTraps({
      blocks: [],
      overlay: [],
      booleanInputPaths: [],
    }),
    overlayIssues: [],
    configDefects: [],
    fidelity: [],
    roundTrip: cleanRoundTrip(),
  });

  test("a clean save passes", () => {
    expect(
      scoreAuthoringRun({ turnError: null, attempt: savedAttempt() }).outcome,
    ).toBe("pass");
  });

  test("any single defect makes the run partial", () => {
    expect(
      scoreAuthoringRun({
        turnError: null,
        attempt: {
          ...savedAttempt(),
          configDefects: ["scope has no ai_prompt"],
        },
      }).outcome,
    ).toBe("partial");
    expect(
      scoreAuthoringRun({
        turnError: null,
        attempt: {
          ...savedAttempt(),
          roundTrip: { ...cleanRoundTrip(), conditionalRowKept: true },
        },
      }).outcome,
    ).toBe("partial");
    expect(
      scoreAuthoringRun({
        turnError: null,
        attempt: { ...savedAttempt(), fidelity: ['dropped "MIETVERTRAG"'] },
      }).outcome,
    ).toBe("partial");
  });

  test("a provider error outranks everything, and no call is its own outcome", () => {
    expect(
      scoreAuthoringRun({ turnError: "refused", attempt: savedAttempt() })
        .outcome,
    ).toBe("error");
    expect(scoreAuthoringRun({ turnError: null, attempt: null }).outcome).toBe(
      "no-call",
    );
  });

  test("bytes that are not a DOCX are reported apart from a rejected overlay", () => {
    expect(
      scoreAuthoringRun({
        turnError: null,
        attempt: {
          status: "invalid-docx",
          reason: "Missing word/document.xml",
        },
      }).outcome,
    ).toBe("invalid-docx");
    const rejected = scoreAuthoringRun({
      turnError: null,
      attempt: { status: "rejected", overlayIssues: ['No field "x"'] },
    });
    expect(rejected.outcome).toBe("partial");
    expect(rejected.overlayIssues).toEqual(['No field "x"']);
  });
});

describe("scoreSyntaxQuiz", () => {
  const expected = { each_closer: "{{/each}}", this_prefix_supported: false };

  test("whitespace inside a marker answer does not change it", () => {
    expect(
      scoreSyntaxQuiz(
        { each_closer: "{{ /each }}", this_prefix_supported: false },
        expected,
      ),
    ).toEqual({ correct: 2, total: 2, wrong: [] });
  });

  test("a wrong, missing, or wrongly-typed answer is wrong, never absent", () => {
    expect(
      scoreSyntaxQuiz({ each_closer: "{{/endeach}}" }, expected).wrong,
    ).toEqual(["each_closer", "this_prefix_supported"]);
    expect(
      scoreSyntaxQuiz(
        { each_closer: "{{/each}}", this_prefix_supported: "no" },
        expected,
      ).wrong,
    ).toEqual(["this_prefix_supported"]);
    expect(scoreSyntaxQuiz(null, expected).correct).toBe(0);
  });
});
