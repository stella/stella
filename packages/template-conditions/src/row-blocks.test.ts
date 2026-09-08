import { describe, expect, test } from "bun:test";

import { detectRowBlockPair } from "./row-blocks.js";

/** One cell holding a single paragraph, the shape a table row usually has. */
const row = (...cells: string[]): string[][] => cells.map((cell) => [cell]);

describe("detectRowBlockPair", () => {
  test("an opener prefixing a cell and a closer suffixing a later cell pair up", () => {
    const pair = detectRowBlockPair(
      row("{% for d in deliverables %}{{ d.item }}", "{{ d.fee }}{% endfor %}"),
    );

    expect(pair?.open).toMatchObject({ cellIndex: 0, paragraphIndex: 0 });
    expect(pair?.open.marker.raw).toBe("{% for d in deliverables %}");
    expect(pair?.close).toMatchObject({ cellIndex: 1, paragraphIndex: 0 });
    expect(pair?.close.marker.raw).toBe("{% endfor %}");
  });

  test("the {% if %} family pairs the same way", () => {
    const pair = detectRowBlockPair(
      row("{% if penalty %}Late fee", "{{penalty_amount}}{% endif %}"),
    );

    expect(pair?.open.marker.meta.kind).toBe("if");
    expect(pair?.close.marker.meta.kind).toBe("endif");
  });

  test("leading and trailing whitespace does not break the placement", () => {
    expect(
      detectRowBlockPair(
        row("  {% for i in x %}{{i.a}}", "{{i.b}}{% endfor %}  "),
      ),
    ).not.toBeNull();
  });

  test("the opener must stand in front of everything the cell says", () => {
    expect(
      detectRowBlockPair(
        row("Item: {% for i in x %}{{i.a}}", "{{i.b}}{% endfor %}"),
      ),
    ).toBeNull();
  });

  test("the closer must stand behind everything the cell says", () => {
    expect(
      detectRowBlockPair(
        row("{% for i in x %}{{i.a}}", "{{i.b}}{% endfor %} net"),
      ),
    ).toBeNull();
  });

  test("a half pair is left to the engine's structure errors", () => {
    expect(
      detectRowBlockPair(row("{% for i in x %}{{i.a}}", "Fee")),
    ).toBeNull();
    expect(detectRowBlockPair(row("Item", "{{i.b}}{% endfor %}"))).toBeNull();
  });

  test("mismatched families do not pair", () => {
    expect(
      detectRowBlockPair(row("{% for i in x %}{{i.a}}", "{{i.b}}{% endif %}")),
    ).toBeNull();
  });

  test("two row blocks in one row are out of scope", () => {
    expect(
      detectRowBlockPair(
        row(
          "{% for i in x %}{{i.a}}",
          "{% if paid %}paid",
          "yes{% endif %}",
          "{{i.b}}{% endfor %}",
        ),
      ),
    ).toBeNull();
  });

  test("a pair that closes inside its own paragraph is inline, not a row block", () => {
    expect(
      detectRowBlockPair(row("{% if paid %}paid{% endif %}", "Fee")),
    ).toBeNull();
  });

  test("an inline pair beside a row block leaves the row block detectable", () => {
    const pair = detectRowBlockPair(
      row(
        "{% for i in x %}{{i.a}}",
        "{% if i.paid %}paid{% endif %}",
        "{{i.b}}{% endfor %}",
      ),
    );

    expect(pair?.open.cellIndex).toBe(0);
    expect(pair?.close.cellIndex).toBe(2);
  });

  test("markers that own their paragraph belong to the block engine", () => {
    expect(
      detectRowBlockPair([
        ["{% for i in x %}", "{{i.a}}"],
        ["{{i.b}}", "{% endfor %}"],
      ]),
    ).toBeNull();
  });

  test("a cell's first and last content paragraph carry the markers", () => {
    expect(
      detectRowBlockPair([
        ["{% for i in x %}{{i.a}}", "note"],
        ["note", "{{i.b}}{% endfor %}"],
      ]),
    ).not.toBeNull();
    expect(
      detectRowBlockPair([
        ["note", "{% for i in x %}{{i.a}}"],
        ["{{i.b}}{% endfor %}", "note"],
      ]),
    ).toBeNull();
  });

  test("a stray {% else %} is not a row block", () => {
    expect(
      detectRowBlockPair(
        row("{% if paid %}paid", "no{% else %}", "yes{% endif %}"),
      ),
    ).toBeNull();
  });

  test("a branch marker stranded in the opener's cell refuses the pair", () => {
    // Only the opener and the closer are ever hoisted, so a `{% else %}` buried
    // in a cell would be dropped with the row when the condition is false.
    expect(
      detectRowBlockPair(
        row("{% if paid %}Paid{% else %}Unpaid", "Amount{% endif %}"),
      ),
    ).toBeNull();
    expect(
      detectRowBlockPair(
        row(
          "{% if paid %}Paid",
          "Unpaid{% elif refunded %}",
          "Amount{% endif %}",
        ),
      ),
    ).toBeNull();
  });

  test("a branch that closes inside its own paragraph leaves the row block", () => {
    const pair = detectRowBlockPair(
      row(
        "{% for i in x %}{{i.a}}",
        "{% if i.paid %}yes{% else %}no{% endif %}",
        "{{i.b}}{% endfor %}",
      ),
    );

    expect(pair?.open.marker.meta.kind).toBe("for");
    expect(pair?.close.cellIndex).toBe(2);
  });

  test("both markers in one cell's paragraphs is not a row block", () => {
    // Cell to cell only: this reads as a block scoped to the cell, and the row
    // is the only unit the placement can act on.
    expect(
      detectRowBlockPair([["{% for i in x %}Item", "Fee{% endfor %}"]]),
    ).toBeNull();
    expect(
      detectRowBlockPair([
        ["{% for i in x %}Item", "Fee{% endfor %}"],
        ["Net"],
      ]),
    ).toBeNull();
  });
});
