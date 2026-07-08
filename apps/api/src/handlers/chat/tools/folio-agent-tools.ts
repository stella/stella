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
 * Client-executed document tools backed by `@stll/folio-agents`'
 * provider-neutral tool catalog. All of these run against the live DOCX
 * editor ref (`DocxEditorRef` from `@stll/folio-react`) that the file
 * overlay's client executor drives (`file-chat-overlay.tsx`), so they are
 * gated on `hasActiveDocxFileClient` in `chat-tools.ts` — only the file
 * overlay mounts the watcher / approval handler that resolves them.
 *
 * `@stll/folio-agents` describes eleven tools; this app registers seven of
 * them, split by how the client resolves each:
 *
 * - READ, auto-run (no approval): `read_document`, `find_text`,
 *   `read_changes`, `read_comments`. The overlay's auto-run watcher executes
 *   these against the live editor bridge and answers with `addToolResult` the
 *   moment their input finishes streaming. `read_changes` /  `read_comments`
 *   became honest to register once `@stll/folio-react` 0.4.0 gave
 *   `DocxEditorRef` a real tracked-change / comment-anchor read surface
 *   (`getTrackedChanges` / `getCommentAnchors`) that `createEditorRefBridge`
 *   maps into the bridge — before that a "read comments" tool would have
 *   returned a permanently-empty list and misled the model.
 * - MUTATION (needs approval): `add_comment`, `reply_comment`,
 *   `resolve_comment`. Each carries `needsApproval: true` and is resolved
 *   through the same approval flow as `apply-active-docx-edits`: the overlay
 *   executes them against the editor bridge (`getComments` / `setComments`
 *   wired to the host's controlled `comments` state) only after the user
 *   approves.
 *
 * Deliberately NOT registered:
 * - `suggest_changes` overlaps the existing `apply-active-docx-edits` tool
 *   (`active-docx-edit-tool.ts`), which already covers proposing edits as
 *   tracked changes for human review. Registering both would give the model
 *   two competing ways to do the same thing.
 * - `read_page` / `read_selection` / `scroll_to_block` are navigation-only
 *   live-editor capabilities with no chat surface driving them yet.
 */
export const READ_DOCUMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.readDocument;
export const FIND_TEXT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.findText;
export const READ_CHANGES_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.readChanges;
export const READ_COMMENTS_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.readComments;
export const ADD_COMMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.addComment;
export const REPLY_COMMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.replyComment;
export const RESOLVE_COMMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.resolveComment;

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

/** A read-only, auto-run folio-agents doc tool (no per-call approval). */
const readDocTool = (
  definitions: readonly FolioAgentToolDefinition[],
  name: FolioAgentToolName,
) => {
  const definition = requireFolioToolDefinition(definitions, name);
  return toolDefinition({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  });
};

/** A mutation folio-agents doc tool, resolved through the approval flow. */
const mutationDocTool = (
  definitions: readonly FolioAgentToolDefinition[],
  name: FolioAgentToolName,
) => {
  const definition = requireFolioToolDefinition(definitions, name);
  return toolDefinition({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    needsApproval: true,
  });
};

/**
 * Build the client-executed folio-agents doc tools from
 * `getFolioToolDefinitions()`. Descriptions and JSON-Schema input schemas
 * come straight from `@stll/folio-agents` (raw JSON Schema — no valibot
 * wrapping, no manual provider-safe projection: both are handled generically
 * downstream, the same way `external-mcp-tools-normalization.ts` already
 * proves raw JSON Schema tool definitions work end to end).
 *
 * Client-executed (no `.server()`). Read tools carry no `needsApproval` and
 * are classified `CHAT_TOOL_POLICY_KIND.internal` in `chat-tools.ts`; the
 * mutation tools carry `needsApproval: true` and are classified
 * `CHAT_TOOL_POLICY_KIND.mutation`, resolved through the same approval flow as
 * `apply-active-docx-edits`. The explicit object literal (rather than a
 * mapped/`fromEntries` build) is deliberate: it keeps each tool name as a
 * literal key so `ChatUITools` and the `chat-tools.ts` policy record stay
 * exhaustively typed over these names.
 */
export const createFolioAgentDocTools = () => {
  const definitions = getFolioToolDefinitions();

  return {
    [READ_DOCUMENT_TOOL_NAME]: readDocTool(
      definitions,
      READ_DOCUMENT_TOOL_NAME,
    ),
    [FIND_TEXT_TOOL_NAME]: readDocTool(definitions, FIND_TEXT_TOOL_NAME),
    [READ_CHANGES_TOOL_NAME]: readDocTool(definitions, READ_CHANGES_TOOL_NAME),
    [READ_COMMENTS_TOOL_NAME]: readDocTool(
      definitions,
      READ_COMMENTS_TOOL_NAME,
    ),
    [ADD_COMMENT_TOOL_NAME]: mutationDocTool(
      definitions,
      ADD_COMMENT_TOOL_NAME,
    ),
    [REPLY_COMMENT_TOOL_NAME]: mutationDocTool(
      definitions,
      REPLY_COMMENT_TOOL_NAME,
    ),
    [RESOLVE_COMMENT_TOOL_NAME]: mutationDocTool(
      definitions,
      RESOLVE_COMMENT_TOOL_NAME,
    ),
  };
};
