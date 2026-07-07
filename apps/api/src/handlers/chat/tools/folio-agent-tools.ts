import { toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";

import {
  FOLIO_AGENT_TOOL_NAMES,
  getFolioToolDefinitions,
} from "@stll/folio-agents";
import type {
  FolioAgentToolDefinition,
  FolioAgentToolName,
} from "@stll/folio-agents";

/**
 * Client-executed, no-approval, read-only document tools backed by
 * `@stll/folio-agents`' provider-neutral tool catalog.
 *
 * `@stll/folio-agents` describes eleven tools (read/find/comment/mutate/
 * navigate), but only `read_document` and `find_text` are registered here.
 * The rest need a `FolioAgentBridge` surface this app cannot honestly
 * provide yet:
 *
 * - `read_comments` / `reply_comment` / `resolve_comment` need a live
 *   comment-thread surface. `DocxEditorRef` (the live editor ref this
 *   file's client executor drives) exposes no comment/tracked-change
 *   read/write surface today, so a `getComments`/`setComments` pair would
 *   be permanently-empty no-ops. Registering a "read comments" tool that
 *   always returns an empty list would mislead the model into reporting
 *   "no comments" on documents that do have them, rather than the tool
 *   being genuinely unsupported here.
 * - `read_changes` has the same gap: no tracked-change read surface.
 * - `add_comment` / `suggest_changes` overlap with the existing
 *   `apply-active-docx-edits` tool (see `active-docx-edit-tool.ts`), which
 *   already covers proposing edits as tracked changes for human review.
 *   Adding `suggest_changes` alongside it would give the model two
 *   competing ways to do the same thing.
 * - `read_page` / `read_selection` / `scroll_to_block` are live-editor-only
 *   capabilities layered on top of the same missing bridge surface.
 *
 * Only `read_document` and `find_text` need nothing beyond a `snapshot()`,
 * which `createEditorRefBridge` (in `@stll/folio-agents`) can already
 * derive from `DocxEditorRef` alone. Revisit this list once `DocxEditorRef`
 * grows a comment/tracked-change surface.
 */
export const READ_DOCUMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.readDocument;
export const FIND_TEXT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.findText;

const requireFolioToolDefinition = (
  definitions: readonly FolioAgentToolDefinition[],
  name: FolioAgentToolName,
): FolioAgentToolDefinition => {
  const definition = definitions.find((candidate) => candidate.name === name);
  return (
    definition ??
    panic(`@stll/folio-agents no longer exposes a "${name}" tool definition`)
  );
};

/**
 * Build the `read_document` / `find_text` chat tools from
 * `getFolioToolDefinitions()`. Descriptions and JSON-Schema input schemas
 * come straight from `@stll/folio-agents` (raw JSON Schema — no valibot
 * wrapping, no manual provider-safe projection: both are handled generically
 * downstream, the same way `external-mcp-tools-normalization.ts` already
 * proves raw JSON Schema tool definitions work end to end).
 *
 * Client-executed (no `.server()`) and read-only, so no `needsApproval`:
 * `chat-tools.ts` classifies both names as
 * `CHAT_TOOL_POLICY_KIND.internal`.
 */
export const createFolioAgentDocTools = () => {
  const definitions = getFolioToolDefinitions();
  const readDocument = requireFolioToolDefinition(
    definitions,
    READ_DOCUMENT_TOOL_NAME,
  );
  const findText = requireFolioToolDefinition(definitions, FIND_TEXT_TOOL_NAME);

  return {
    [READ_DOCUMENT_TOOL_NAME]: toolDefinition({
      name: readDocument.name,
      description: readDocument.description,
      inputSchema: readDocument.inputSchema,
    }),
    [FIND_TEXT_TOOL_NAME]: toolDefinition({
      name: findText.name,
      description: findText.description,
      inputSchema: findText.inputSchema,
    }),
  };
};
