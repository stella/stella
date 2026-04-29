import { describe, expect, test } from "bun:test";

import { schema } from "../../schema";

describe("FieldExtension", () => {
  test("uses DOCX field-instruction parsing for quoted MERGEFIELD names", () => {
    const field = schema.node("field", {
      fieldType: "MERGEFIELD",
      instruction: ' MERGEFIELD "Client Name" \\* MERGEFORMAT ',
      displayText: "",
      fieldKind: "simple",
    });

    const toDOM = field.type.spec.toDOM;
    if (!toDOM) {
      throw new Error("Expected field node to provide toDOM");
    }

    const domSpec = toDOM(field) as [string, Record<string, string>, string];

    expect(domSpec[0]).toBe("span");
    expect(domSpec[1]["data-field-type"]).toBe("MERGEFIELD");
    expect(domSpec[2]).toBe("«Client Name»");
  });

  test("keeps cached display text for fields the layout path does not recompute", () => {
    const field = schema.node("field", {
      fieldType: "REF",
      instruction: " REF _Ref123 \\h ",
      displayText: "Clause 4.2",
      fieldKind: "complex",
    });

    const toDOM = field.type.spec.toDOM;
    if (!toDOM) {
      throw new Error("Expected field node to provide toDOM");
    }

    const domSpec = toDOM(field) as [string, Record<string, string>, string];

    expect(domSpec[1]["data-field-type"]).toBe("REF");
    expect(domSpec[2]).toBe("Clause 4.2");
  });
});
