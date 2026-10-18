import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "pdfium",
  capability: "Calling PDFium to load PDF documents and render their pages",
  owner: ["apps/api/src/lib/files/pdfium.ts"],
  summary:
    "PDFium runs as WASM with a manually managed heap: document bytes stay " +
    "allocated until the document closes, page and bitmap handles must be " +
    "released, and heap views go stale when the heap grows. One module owns " +
    "those rules and returns typed results, so no caller holds a raw handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@embedpdf/pdfium"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
