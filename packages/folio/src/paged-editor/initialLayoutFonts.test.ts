import { describe, expect, test } from "bun:test";

import { toProseDoc } from "../core/prosemirror";
import { createEmptyDocument } from "../core/utils/createDocument";
import { collectInitialLayoutFontFamilies } from "./PagedEditor";

describe("initial layout font loading", () => {
  test("loads only document-driven font families plus metric-compatible fallbacks", () => {
    const document = createEmptyDocument({ initialText: "Hello" });
    const pmDoc = toProseDoc(document);

    const families = collectInitialLayoutFontFamilies(document, pmDoc);

    expect(families).toContain("Calibri");
    expect(families).toContain("Carlito");
    expect(families).toContain("Arial");
    expect(families).toContain("Arimo");
    expect(families).not.toContain("Cambria");
    expect(families).not.toContain("Times New Roman");
    expect(families).not.toContain("Courier New");
  });
});
