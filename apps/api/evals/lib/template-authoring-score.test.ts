import { describe, expect, test } from "bun:test";

import type { AuthoredBlock, SaveAttempt } from "./template-authoring-score";
import {
  checkSourceFidelity,
  cleanRoundTrip,
  comparePaths,
  detectGrammarTraps,
  isEntryOverlayIssue,
  scoreAuthoringRun,
  scoreSyntaxQuiz,
} from "./template-authoring-score";

const paragraph = (text: string): AuthoredBlock => ({
  type: "paragraph",
  text,
});

const table = (...rows: readonly string[][]): AuthoredBlock => ({
  type: "table",
  rows,
});

const traps = (
  blocks: readonly AuthoredBlock[],
  overlay = [],
  booleanInputPaths: string[] = [],
) => detectGrammarTraps({ blocks, overlay, booleanInputPaths });

describe("detectGrammarTraps", () => {
  test("a correctly authored repeat trips nothing", () => {
    const counts = traps([
      paragraph("{% for attorney in attorneys %}"),
      paragraph("{{ attorney.name }}, {{ attorney.role }}"),
      paragraph("{% endfor %}"),
    ]);
    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
  });

  test("an item path that misses the loop alias is counted once per occurrence", () => {
    const counts = traps([
      paragraph("{% for attorney in attorneys %}"),
      paragraph("{{name}} — {{role}}"),
      paragraph("{% endfor %}"),
    ]);
    expect(counts.unaliased_item_path).toBe(2);
  });

  test("the array path still resolves inside its own loop", () => {
    const counts = traps([
      paragraph("{% for attorney in attorneys %}"),
      paragraph("{{ attorneys.name }}"),
      paragraph("{% endfor %}"),
    ]);
    expect(counts.unaliased_item_path).toBe(0);
  });

  test("each rejected marker shape is counted as its own trap", () => {
    const counts = traps([
      paragraph("{% for attorney in attorneys %}"),
      paragraph("{{attorneys[0].name}}"),
      paragraph("{{#each attorneys}}"),
      paragraph("{% set total = 1 %}"),
      paragraph("{{ fee | upper }}"),
      paragraph("{{ fee * 12 }}"),
    ]);
    expect(counts.bracket_index).toBe(1);
    expect(counts.legacy_marker).toBe(1);
    expect(counts.unsupported_tag).toBe(1);
    expect(counts.unknown_filter).toBe(1);
    expect(counts.python_expression).toBe(1);
  });

  test("an inline span the engine parses is a placement, not a trap", () => {
    const counts = traps([
      paragraph("{% if penalty %}A penalty applies.{% endif %}"),
      paragraph(
        "The tenant{% if guarantor %}, with the guarantor,{% endif %} pays.",
      ),
      paragraph(
        "{% for a in attorneys %}{{ a.name }}{% if not loop.last %}, {% endif %}{% endfor %}",
      ),
      paragraph("{% for row in rows %}"),
      paragraph("{{ row.name }}"),
      paragraph("{% endfor %}"),
    ]);
    expect(counts.block_marker_inline).toBe(0);
  });

  test("an opener alone in a paragraph is the block form", () => {
    expect(
      traps([
        paragraph("{% if penalty %}"),
        paragraph("A penalty applies."),
        paragraph("{% endif %}"),
      ]).block_marker_inline,
    ).toBe(0);
  });

  test("an opener inline with text and no closer in the paragraph is a trap", () => {
    expect(
      traps([
        paragraph("A penalty applies{% if waived %} unless waived."),
        paragraph("{% endif %}"),
      ]).block_marker_inline,
    ).toBe(1);
  });

  test("a row block opened and closed across one row's cells is a placement, not a trap", () => {
    const counts = traps([
      table(
        ["Deliverable", "Fee"],
        [
          "{% for deliverable in deliverables %}{{ deliverable.item }}",
          "{{ deliverable.fee }}{% endfor %}",
        ],
      ),
      table(["{% if penalty %}Late fee", "{{penalty_amount}}{% endif %}"]),
    ]);
    expect(counts.block_marker_inline).toBe(0);
    expect(counts.unaliased_item_path).toBe(0);
  });

  test("an unclosed block marker in a plain paragraph is still a trap", () => {
    expect(
      traps([paragraph("{% if penalty %}A penalty applies.")])
        .block_marker_inline,
    ).toBe(1);
  });

  test("a row whose opener has no closer is still a trap", () => {
    expect(
      traps([
        table([
          "{% for deliverable in deliverables %}{{ deliverable.item }}",
          "Fee",
        ]),
      ]).block_marker_inline,
    ).toBe(1);
  });

  test("a branch marker buried in a row's cell is still a trap", () => {
    // Not a row block: only the opener and closer are ever hoisted, so this
    // placement loses the branch.
    expect(
      traps([table(["{% if paid %}Paid{% else %}Unpaid", "Amount{% endif %}"])])
        .block_marker_inline,
    ).toBe(2);
  });

  test("a pair wrapping one cell's own paragraphs is still a trap", () => {
    expect(
      traps([table(["{% for item in x %}Item\nFee{% endfor %}"])])
        .block_marker_inline,
    ).toBe(2);
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

  test("a lookup inside an {% for %} keeps its dotted path without tripping", () => {
    expect(
      detectGrammarTraps({
        blocks: [
          paragraph("{% for company in companies %}"),
          paragraph("{{ company.krs }}"),
          paragraph("{% endfor %}"),
        ],
        overlay: [{ path: "companies.krs", lookup: { formats: [] } }],
        booleanInputPaths: [],
      }).lookup_not_parent,
    ).toBe(0);
  });

  test("a condition on a tick-box field, or one restating its own path, is condition_on_input", () => {
    expect(
      detectGrammarTraps({
        blocks: [paragraph("{% if penalty %}")],
        overlay: [{ path: "penalty", condition: "penalty == true" }],
        booleanInputPaths: [],
      }).condition_on_input,
    ).toBe(1);
    expect(
      detectGrammarTraps({
        blocks: [paragraph("{% if penalty %}")],
        overlay: [{ path: "penalty", condition: "amount > 0" }],
        booleanInputPaths: ["penalty"],
      }).condition_on_input,
    ).toBe(1);
    expect(
      detectGrammarTraps({
        blocks: [paragraph("{% if has_penalty %}")],
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

describe("isEntryOverlayIssue", () => {
  test("an entry path is the entry, a property path is one property of it", () => {
    expect(isEntryOverlayIssue({ path: "fields.3" })).toBe(true);
    expect(isEntryOverlayIssue({ path: "fields.12" })).toBe(true);
    expect(isEntryOverlayIssue({ path: "fields.3.parts" })).toBe(false);
    expect(isEntryOverlayIssue({ path: "fields.3.lookup.formats" })).toBe(
      false,
    );
    expect(isEntryOverlayIssue({ path: "template_id" })).toBe(false);
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
    propertyDrops: [],
    configDefects: [],
    fidelity: [],
    roundTrip: cleanRoundTrip(),
  });

  test("a clean save passes", () => {
    expect(
      scoreAuthoringRun({
        created: false,
        turnError: null,
        attempt: savedAttempt(),
      }).outcome,
    ).toBe("pass");
  });

  test("any single defect makes the run partial", () => {
    expect(
      scoreAuthoringRun({
        created: false,
        turnError: null,
        attempt: {
          ...savedAttempt(),
          configDefects: ["scope has no ai_prompt"],
        },
      }).outcome,
    ).toBe("partial");
    expect(
      scoreAuthoringRun({
        created: false,
        turnError: null,
        attempt: {
          ...savedAttempt(),
          roundTrip: { ...cleanRoundTrip(), conditionalRowKept: true },
        },
      }).outcome,
    ).toBe("partial");
    expect(
      scoreAuthoringRun({
        created: false,
        turnError: null,
        attempt: { ...savedAttempt(), fidelity: ['dropped "MIETVERTRAG"'] },
      }).outcome,
    ).toBe("partial");
  });

  test("a property drop is reported without failing the configure step", () => {
    const dropped = scoreAuthoringRun({
      created: true,
      turnError: null,
      attempt: {
        ...savedAttempt(),
        propertyDrops: ["fields.3.parts: `parts` is not a property."],
      },
    });
    expect(dropped.outcome).toBe("pass");
    expect(dropped.steps.configured).toBe(true);
    expect(dropped.propertyDrops).toEqual([
      "fields.3.parts: `parts` is not a property.",
    ]);
  });

  test("a provider error overrides the outcome without discarding saved diagnostics", () => {
    const providerError = scoreAuthoringRun({
      created: false,
      turnError: "provider refused the request",
      attempt: {
        ...savedAttempt(),
        paths: { missing: ["company"], extra: [] },
        configDefects: ["company has no lookup"],
      },
    });
    expect(providerError.outcome).toBe("error");
    expect(providerError.note).toBe("provider refused the request");
    expect(providerError.paths.missing).toEqual(["company"]);
    expect(providerError.configDefects).toEqual(["company has no lookup"]);
  });

  test("the four steps are scored separately, so a run says where it stopped", () => {
    const clean = scoreAuthoringRun({
      created: true,
      turnError: null,
      attempt: savedAttempt(),
    });
    expect(clean.steps).toEqual({
      authored: true,
      created: true,
      configured: true,
      filled: true,
    });

    // A document that authored cleanly and was created, whose configuration
    // was refused entry by entry and whose fill then left markers behind.
    const configureFailed = scoreAuthoringRun({
      created: true,
      turnError: null,
      attempt: {
        ...savedAttempt(),
        overlayIssues: ["fields.0: No marker {{ghost}} in the DOCX."],
        roundTrip: { ...cleanRoundTrip(), leftoverMarkers: 2 },
      },
    });
    expect(configureFailed.steps).toEqual({
      authored: true,
      created: true,
      configured: false,
      filled: false,
    });

    // A grammar trap is an authoring failure even when everything after it
    // succeeded.
    const trapped = scoreAuthoringRun({
      created: true,
      turnError: null,
      attempt: {
        ...savedAttempt(),
        traps: { ...savedAttempt().traps, unaliased_item_path: 1 },
      },
    });
    expect(trapped.steps.authored).toBe(false);
    expect(trapped.steps.created).toBe(true);
  });

  test("a turn that never created still reports what it authored", () => {
    const unsaved = scoreAuthoringRun({
      created: false,
      turnError: null,
      attempt: {
        status: "unsaved",
        paths: { missing: [], extra: [] },
        traps: savedAttempt().traps,
        overlayIssues: [],
        fidelity: [],
      },
    });
    expect(unsaved.steps).toEqual({
      authored: true,
      created: false,
      configured: false,
      filled: false,
    });
  });

  test("a configure refused after a successful create still credits the create", () => {
    const rejected = scoreAuthoringRun({
      created: true,
      turnError: null,
      attempt: { status: "rejected", overlayIssues: ["fields.0: nope"] },
    });
    expect(rejected.steps.created).toBe(true);
    expect(rejected.steps.configured).toBe(false);
  });

  test("a provider error with no attempt has no diagnostics", () => {
    const providerError = scoreAuthoringRun({
      created: false,
      turnError: "provider refused the request",
      attempt: null,
    });
    expect(providerError.outcome).toBe("error");
    expect(providerError.note).toBe("provider refused the request");
    expect(providerError.paths).toEqual({ missing: [], extra: [] });
  });

  test("no call without a provider error is its own outcome", () => {
    expect(
      scoreAuthoringRun({ created: false, turnError: null, attempt: null })
        .outcome,
    ).toBe("no-call");
  });

  test("bytes that are not a DOCX are reported apart from a rejected overlay", () => {
    expect(
      scoreAuthoringRun({
        created: false,
        turnError: null,
        attempt: {
          status: "invalid-docx",
          reason: "Missing word/document.xml",
        },
      }).outcome,
    ).toBe("invalid-docx");
    const rejected = scoreAuthoringRun({
      created: false,
      turnError: null,
      attempt: { status: "rejected", overlayIssues: ['No field "x"'] },
    });
    expect(rejected.outcome).toBe("partial");
    expect(rejected.overlayIssues).toEqual(['No field "x"']);
  });

  test("an unsaved document earns partial credit for its authored markers", () => {
    const score = scoreAuthoringRun({
      created: false,
      turnError: null,
      attempt: {
        status: "unsaved",
        paths: { missing: [], extra: [] },
        traps: detectGrammarTraps({
          blocks: [paragraph("Hello {{name}}")],
          overlay: [],
          booleanInputPaths: [],
        }),
        overlayIssues: [],
        fidelity: [],
      },
    });

    expect(score.outcome).toBe("partial");
    expect(score.paths).toEqual({ missing: [], extra: [] });
    expect(Object.values(score.traps).every((count) => count === 0)).toBe(true);
    expect(score.note).toBe("authored DOCX was not saved");
  });

  test("an unsaved document keeps its evidence when the turn errors", () => {
    const score = scoreAuthoringRun({
      created: false,
      turnError: "output token limit reached",
      attempt: {
        status: "unsaved",
        paths: { missing: ["signing_date"], extra: [] },
        traps: detectGrammarTraps({
          blocks: [
            paragraph("{% for attorney in attorneys %}"),
            paragraph("{{name}}"),
          ],
          overlay: [],
          booleanInputPaths: [],
        }),
        overlayIssues: [],
        fidelity: ['dropped "POWER OF ATTORNEY"'],
      },
    });

    expect(score.outcome).toBe("error");
    expect(score.note).toBe("output token limit reached");
    expect(score.paths.missing).toEqual(["signing_date"]);
    expect(score.traps.unaliased_item_path).toBe(1);
    expect(score.fidelity).toEqual(['dropped "POWER OF ATTORNEY"']);
  });
});

describe("scoreSyntaxQuiz", () => {
  const expected = {
    each_closer: "{% endfor %}",
    this_prefix_supported: false,
  };

  test("whitespace inside a marker answer does not change it", () => {
    expect(
      scoreSyntaxQuiz(
        { each_closer: "{% endfor %}", this_prefix_supported: false },
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
        { each_closer: "{% endfor %}", this_prefix_supported: "no" },
        expected,
      ).wrong,
    ).toEqual(["this_prefix_supported"]);
    expect(scoreSyntaxQuiz(null, expected).correct).toBe(0);
  });
});
