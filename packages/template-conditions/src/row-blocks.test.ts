import { describe, expect, test } from "bun:test";

import { detectRowBlockPair } from "./row-blocks.js";

/** One cell holding a single paragraph, the shape a table row usually has. */
const row = (...cells: string[]): string[][] => cells.map((cell) => [cell]);

describe("detectRowBlockPair", () => {
  test("an opener prefixing a cell and a closer suffixing a later cell pair up", () => {
    const pair = detectRowBlockPair(
      row(
        "{{#each deliverables}}{{deliverables.item}}",
        "{{deliverables.fee}}{{/each}}",
      ),
    );

    expect(pair?.open).toMatchObject({ cellIndex: 0, paragraphIndex: 0 });
    expect(pair?.open.marker.raw).toBe("{{#each deliverables}}");
    expect(pair?.close).toMatchObject({ cellIndex: 1, paragraphIndex: 0 });
    expect(pair?.close.marker.raw).toBe("{{/each}}");
  });

  test("the {{#if}} family pairs the same way", () => {
    const pair = detectRowBlockPair(
      row("{{#if penalty}}Late fee", "{{penalty_amount}}{{/if}}"),
    );

    expect(pair?.open.marker.meta.kind).toBe("if");
    expect(pair?.close.marker.meta.kind).toBe("endif");
  });

  test("leading and trailing whitespace does not break the placement", () => {
    expect(
      detectRowBlockPair(row("  {{#each x}}{{x.a}}", "{{x.b}}{{/each}}  ")),
    ).not.toBeNull();
  });

  test("the opener must stand in front of everything the cell says", () => {
    expect(
      detectRowBlockPair(row("Item: {{#each x}}{{x.a}}", "{{x.b}}{{/each}}")),
    ).toBeNull();
  });

  test("the closer must stand behind everything the cell says", () => {
    expect(
      detectRowBlockPair(row("{{#each x}}{{x.a}}", "{{x.b}}{{/each}} net")),
    ).toBeNull();
  });

  test("a half pair is left to the engine's structure errors", () => {
    expect(detectRowBlockPair(row("{{#each x}}{{x.a}}", "Fee"))).toBeNull();
    expect(detectRowBlockPair(row("Item", "{{x.b}}{{/each}}"))).toBeNull();
  });

  test("mismatched families do not pair", () => {
    expect(
      detectRowBlockPair(row("{{#each x}}{{x.a}}", "{{x.b}}{{/if}}")),
    ).toBeNull();
  });

  test("two row blocks in one row are out of scope", () => {
    expect(
      detectRowBlockPair(
        row(
          "{{#each x}}{{x.a}}",
          "{{#if paid}}paid",
          "yes{{/if}}",
          "{{x.b}}{{/each}}",
        ),
      ),
    ).toBeNull();
  });

  test("a pair that closes inside its own paragraph is inline, not a row block", () => {
    expect(
      detectRowBlockPair(row("{{#if paid}}paid{{/if}}", "Fee")),
    ).toBeNull();
  });

  test("an inline pair beside a row block leaves the row block detectable", () => {
    const pair = detectRowBlockPair(
      row(
        "{{#each x}}{{x.a}}",
        "{{#if x.paid}}paid{{/if}}",
        "{{x.b}}{{/each}}",
      ),
    );

    expect(pair?.open.cellIndex).toBe(0);
    expect(pair?.close.cellIndex).toBe(2);
  });

  test("markers that own their paragraph belong to the block engine", () => {
    expect(
      detectRowBlockPair([
        ["{{#each x}}", "{{x.a}}"],
        ["{{x.b}}", "{{/each}}"],
      ]),
    ).toBeNull();
  });

  test("a cell's first and last content paragraph carry the markers", () => {
    expect(
      detectRowBlockPair([
        ["{{#each x}}{{x.a}}", "note"],
        ["note", "{{x.b}}{{/each}}"],
      ]),
    ).not.toBeNull();
    expect(
      detectRowBlockPair([
        ["note", "{{#each x}}{{x.a}}"],
        ["{{x.b}}{{/each}}", "note"],
      ]),
    ).toBeNull();
  });

  test("a stray {{#else}} is not a row block", () => {
    expect(
      detectRowBlockPair(row("{{#if paid}}paid", "no{{#else}}", "yes{{/if}}")),
    ).toBeNull();
  });

  test("a branch marker stranded in the opener's cell refuses the pair", () => {
    // Only the opener and the closer are ever hoisted, so a `{{#else}}` buried
    // in a cell would be dropped with the row when the condition is false.
    expect(
      detectRowBlockPair(
        row("{{#if paid}}Paid{{#else}}Unpaid", "Amount{{/if}}"),
      ),
    ).toBeNull();
    expect(
      detectRowBlockPair(
        row("{{#if paid}}Paid", "Unpaid{{#elseif refunded}}", "Amount{{/if}}"),
      ),
    ).toBeNull();
  });

  test("a branch that closes inside its own paragraph leaves the row block", () => {
    const pair = detectRowBlockPair(
      row(
        "{{#each x}}{{x.a}}",
        "{{#if x.paid}}yes{{#else}}no{{/if}}",
        "{{x.b}}{{/each}}",
      ),
    );

    expect(pair?.open.marker.meta.kind).toBe("each");
    expect(pair?.close.cellIndex).toBe(2);
  });

  test("both markers in one cell's paragraphs is not a row block", () => {
    // Cell to cell only: this reads as a block scoped to the cell, and the row
    // is the only unit the placement can act on.
    expect(
      detectRowBlockPair([["{{#each x}}Item", "Fee{{/each}}"]]),
    ).toBeNull();
    expect(
      detectRowBlockPair([["{{#each x}}Item", "Fee{{/each}}"], ["Net"]]),
    ).toBeNull();
  });
});
