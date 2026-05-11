import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import * as v from "valibot";

export const CREATE_DOCUMENT_TOOL_NAME = "create-document";

// Client-executed: the server defines schema only (no `execute`).
// The chat client resolves the destination matter (using the
// thread's active matter or by prompting the user with the
// matter-pick card), calls `POST /chat/tools/create-document`
// to do the actual compile + persist, and posts the result
// back via the AI SDK's `addToolOutput`. Mirrors the pattern
// used by `apply-active-docx-edits`.
//
// `workspaceId` is intentionally NOT in the input schema —
// matter resolution is a UI concern, not something the model
// should pass.
const createDocumentToolInputSchema = v.strictObject({
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(256),
    v.description("Document file name (without .docx extension)"),
  ),
  source: v.optional(
    v.pipe(
      v.string(),
      v.description(
        "Document body written as `@`-directives (see tool description).",
      ),
    ),
  ),
  markdown: v.optional(
    v.pipe(
      v.string(),
      v.description("Deprecated fallback for old tool calls. Prefer source."),
    ),
  ),
});

const createDocumentToolOutputSchema = v.union([
  v.strictObject({
    success: v.literal(true),
    fileName: v.string(),
    entityId: v.string(),
    workspaceId: v.string(),
    entityRef: v.string(),
    matterRef: v.string(),
    href: v.string(),
    mention: v.string(),
  }),
  v.strictObject({
    success: v.literal(false),
    message: v.string(),
  }),
]);

export type CreateDocumentToolInput = v.InferOutput<
  typeof createDocumentToolInputSchema
>;
export type CreateDocumentToolOutput = v.InferOutput<
  typeof createDocumentToolOutputSchema
>;

export const createCreateDocumentTool = () =>
  tool({
    description:
      "Create a brand-new DOCX. The compiler numbers and paginates " +
      "deterministically — do not write manual clause numbers. This " +
      "does NOT edit, convert, clone or preserve formatting from an " +
      "existing DOCX; never use it when the user asks to edit, rewrite, " +
      "save, update, or make a new version of an already-open document. " +
      "The user picks the destination matter via the UI; do not ask the " +
      "user to identify a matter in your reply. On success, copy the " +
      "`mention` field verbatim when naming the document in your reply.\n\n" +
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
      "PLACEHOLDERS: wrap unknown values in `[[ ]]` — the compiler highlights them in yellow so the user can spot and fill them. Example: `Buyer shall pay [[purchase price]] on or before [[closing date]].` Briefly tell the user in your reply which placeholders you left.\n\n" +
      "@signatures: one block at the end, key:value lines per party. Keys: `party` (legal name), `by` (signing person, alias `name`), `title` (role). Use the document-language alias for the keys — e.g. `party / strana / partei / partie / parte / fél`. Each `party:` line opens a new party block; omit `by` and `title` to leave a blank line for hand-fill. The compiler renders one column per party (party name bolded, signing space, rule, then your `by:` / `title:` values raw) — no compiler-added captions. If you want labels like 'Datum:' or 'Podpis', write them inline in the source above the @signatures block (with @paragraph), in the document's language.",
    inputSchema: valibotSchema(createDocumentToolInputSchema),
    outputSchema: valibotSchema(createDocumentToolOutputSchema),
  });
