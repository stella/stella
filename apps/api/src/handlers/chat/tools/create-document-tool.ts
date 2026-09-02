import { toolDefinition } from "@tanstack/ai";
import * as v from "valibot";

import { CREATE_DOCUMENT_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";

export { CREATE_DOCUMENT_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";

// Client-executed: the server defines schema only (no `execute`).
// The chat client resolves the destination matter (using the
// thread's active matter or by prompting the user with the
// matter-pick card), calls `POST /chat/tools/create-document`
// to do the actual compile + persist, and posts the result
// back via TanStack ChatClient.addToolResult. Mirrors the pattern
// used by `suggest_changes`.
//
// `workspaceId` is intentionally NOT in the input schema —
// matter resolution is a UI concern, not something the model
// should pass.
export const createDocumentToolInputSchema = v.strictObject({
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(256),
    v.description("Document file name (without .docx extension)"),
  ),
  source: v.pipe(
    v.string(),
    v.minLength(1),
    v.description(
      "Document body written as `@`-directives (see tool description).",
    ),
  ),
});

const legalSourceDiagnosticSchema = v.strictObject({
  code: v.string(),
  message: v.string(),
  severity: v.picklist(["warning", "error"]),
  line: v.optional(v.number()),
});

const legalSourceFixSchema = v.strictObject({
  code: v.string(),
  message: v.string(),
  line: v.optional(v.number()),
});

// The compiler's report rides on the result so the model can check what it
// produced without a second call: `fixes` are normalizations the compiler
// applied on its own, `warnings` are kept-but-suspect constructs, `errors`
// are what stopped the compile. Optional on the wire because results
// persisted before the report existed carry none of them.
const compilerReportProperties = {
  fixes: v.optional(
    v.pipe(
      v.array(legalSourceFixSchema),
      v.description(
        "Normalizations the compiler applied to your source (for example a " +
          "stripped manual clause number or a signatures block moved to " +
          "the end). Reissue the full source if one of them changed your " +
          "intent.",
      ),
    ),
  ),
  warnings: v.optional(
    v.pipe(
      v.array(legalSourceDiagnosticSchema),
      v.description("Constructs the compiler kept but flags as suspect."),
    ),
  ),
};

const createDocumentToolOutputSchema = v.union([
  v.strictObject({
    success: v.literal(true),
    fileName: v.string(),
    entityId: v.string(),
    fieldId: v.string(),
    workspaceId: v.string(),
    entityRef: v.string(),
    matterRef: v.string(),
    href: v.string(),
    mention: v.string(),
  }),
  v.strictObject({
    success: v.literal(true),
    destination: v.literal("draft"),
    fileName: v.string(),
    ...compilerReportProperties,
  }),
  v.strictObject({
    success: v.literal(true),
    destination: v.literal("download"),
    fileName: v.string(),
  }),
  v.strictObject({
    success: v.literal(false),
    message: v.string(),
    errors: v.optional(
      v.pipe(
        v.array(legalSourceDiagnosticSchema),
        v.description(
          "What stopped the compile, with the source line where known. " +
            "Fix the source and call the tool again.",
        ),
      ),
    ),
  }),
]);

export type CreateDocumentToolInput = v.InferOutput<
  typeof createDocumentToolInputSchema
>;
export type CreateDocumentToolOutput = v.InferOutput<
  typeof createDocumentToolOutputSchema
>;

export const createCreateDocumentTool = () =>
  toolDefinition({
    name: CREATE_DOCUMENT_TOOL_NAME,
    description:
      "Create a brand-new DOCX. The compiler numbers and paginates " +
      "deterministically — do not write manual clause numbers. This " +
      "does NOT edit, convert, clone or preserve formatting from an " +
      "existing DOCX; never use it when the user asks to edit, rewrite, " +
      "save, update, or make a new version of an already-open document. " +
      "Exception: when the open item is an unsaved draft produced by an " +
      "earlier create-document call in this chat, use create-document again " +
      "with the complete revised source so the live draft is replaced. This " +
      "exception never applies to a persisted matter document. " +
      "The user can save the draft to a destination matter or download it " +
      "without saving. Showing the editable draft completes this tool, so the " +
      "user can keep refining it in later chat turns before saving. Do not ask " +
      "the user to identify a matter in your " +
      "reply. When the success output includes `mention`, copy that field " +
      "verbatim when naming the saved document in your reply.\n\n" +
      "DIRECTIVES (one per block, on its own line):\n" +
      "  @doc kind=<agreement|letter|memo|checklist|pleading|other> locale=<bcp47> page=<A4|Letter> — opening line; locale picks footer + signature captions for en/cs/sk/de/fr/es/it/pl/pt/nl/hu (falls back to English).\n" +
      "  @title <text> — document title.\n" +
      "  @clause <heading> — numbered, titled section. Heading required. Body lines follow on subsequent lines.\n" +
      "  @subclause <heading> — one level deeper.\n" +
      "  @paragraph — plain body paragraph(s); no heading.\n" +
      "  @recital — italic body paragraphs (use for 'WHEREAS …' style intros).\n" +
      "  @list — bullet list. Add `ordered` after `@list` for numbered.\n" +
      "  @table — pipe-style table.\n" +
      "  @schedule <heading> — schedule/annex starting on a new page.\n" +
      "  @signatures — side-by-side party signature block; see below.\n" +
      "  @pagebreak — force a page break.\n\n" +
      "INLINE EMPHASIS: wrap only a short inline label in `**` for bold, for example " +
      "`**Seller:** [[seller name]]`. Never wrap an entire body paragraph, " +
      "table cell, or bilingual column in `**`; use @title, @clause, or @subclause " +
      "for structural headings. The markers are compiled into DOCX runs and are " +
      "not shown literally.\n\n" +
      "RESULT REPORT: the result lists `fixes` the compiler applied on its own " +
      "and `warnings` it kept; a failed compile returns `errors` with source " +
      "lines. Read them: if a fix changed what you meant, call the tool again " +
      "with the corrected full source.\n\n" +
      "PLACEHOLDERS: wrap unknown values in `[[ ]]` — the compiler highlights them in yellow so the user can spot and fill them. Example: `Buyer shall pay [[purchase price]] on or before [[closing date]].` Briefly tell the user in your reply which placeholders you left.\n\n" +
      "@signatures: one block at the end, key:value lines per party. Keys: `party` (legal name), `by` (signing person, alias `name`), `title` (role). Use the document-language alias for the keys — e.g. `party / strana / partei / partie / parte / fél`. Each `party:` line opens a new party block; omit `by` and `title` to leave a blank line for hand-fill. The compiler renders one column per party (party name bolded, signing space, rule, then your `by:` / `title:` values raw) — no compiler-added captions. If you want labels like 'Datum:' or 'Podpis', write them inline in the source above the @signatures block (with @paragraph), in the document's language.",
    inputSchema: toTanStackToolSchema(createDocumentToolInputSchema),
    outputSchema: toTanStackToolSchema(createDocumentToolOutputSchema),
  });
