import { toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";

import {
  DOCX_SUGGEST_CHANGES_OPTIONS_BY_SURFACE,
  type DocxSuggestionSurface,
} from "@stll/api-contract/chat-docx-suggestions";
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
 * editor (`DocxEditorRef` from `@stll/folio-react`) through a
 * `FolioAgentBridge` the client surface builds, so registration is gated on
 * the surface having the matching client executor (see `chat-tools.ts`).
 *
 * Three groups, split by how the client resolves each:
 *
 * - READ, auto-run (no approval): `read_document`, `get_document_outline`,
 *   `read_section`, `list_stories`, `read_story`, `find_text`,
 *   `read_changes`, `read_comments`, `show_in_document`. The file overlay's
 *   auto-run watcher executes these against the live editor bridge and
 *   answers with `addToolResult` the moment their input finishes streaming.
 *   `read_changes` / `read_comments` became honest to register once
 *   `@stll/folio-react` 0.4.0 gave `DocxEditorRef` a real tracked-change /
 *   comment-anchor read surface (`getTrackedChanges` / `getCommentAnchors`).
 * - MUTATION (needs approval): `add_comment`, `reply_comment`,
 *   `resolve_comment`. Each carries `needsApproval: true`; the overlay
 *   executes them against the editor bridge (`getComments` / `setComments`
 *   wired to the host's controlled `comments` state) only after the user
 *   approves.
 * - `suggest_changes`, auto-run (no approval): the one DOCX mutation tool,
 *   in its manual (queue-only) registration. It never writes to the
 *   document on these surfaces; the client executes it through a
 *   review-queue bridge that parks every operation for human accept /
 *   reject (the review panel, or the Studio's in-document suggestions). The
 *   per-surface options in `DOCX_SUGGEST_CHANGES_OPTIONS_BY_SURFACE` shape
 *   its schema; the client passes the same options to
 *   `executeFolioToolCall`. The automatic apply mode registers the same
 *   tool name server-executed instead
 *   (`auto-apply-suggest-changes-tools.ts`).
 *
 * Not registered: `read_page` / `read_selection` / `scroll_to_block` are
 * navigation-only live-editor capabilities with no chat surface driving them.
 */
export const READ_DOCUMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.readDocument;
export const GET_DOCUMENT_OUTLINE_TOOL_NAME =
  FOLIO_AGENT_TOOL_NAMES.getDocumentOutline;
export const READ_SECTION_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.readSection;
export const LIST_STORIES_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.listStories;
export const READ_STORY_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.readStory;
export const FIND_TEXT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.findText;
export const READ_CHANGES_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.readChanges;
export const READ_COMMENTS_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.readComments;
export const SHOW_IN_DOCUMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.showInDocument;
export const ADD_COMMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.addComment;
export const REPLY_COMMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.replyComment;
export const RESOLVE_COMMENT_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.resolveComment;
export const SUGGEST_CHANGES_TOOL_NAME = FOLIO_AGENT_TOOL_NAMES.suggestChanges;

export const requireFolioToolDefinition = (
  definitions: readonly FolioAgentToolDefinition[],
  name: FolioAgentToolName,
): FolioAgentToolDefinition => {
  const definition = definitions.find((candidate) => candidate.name === name);
  return (
    definition ??
    panic(`@stll/folio-agents no longer exposes a "${name}" tool definition`)
  );
};

/** A client-executed folio-agents doc tool the surface auto-runs (no per-call approval). */
const autoRunDocTool = (
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
const approvalDocTool = (
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
 * Build the client-executed folio-agents read and comment tools from
 * `getFolioToolDefinitions()`. Descriptions and JSON-Schema input schemas
 * come straight from `@stll/folio-agents` (raw JSON Schema; no valibot
 * wrapping, no manual provider-safe projection: both are handled generically
 * downstream, the same way `external-mcp-tools-normalization.ts` already
 * proves raw JSON Schema tool definitions work end to end).
 *
 * Client-executed (no `.server()`). Read tools carry no `needsApproval` and
 * are classified `CHAT_TOOL_POLICY_KIND.internal`; the comment mutation
 * tools carry `needsApproval: true` and are classified
 * `CHAT_TOOL_POLICY_KIND.mutation`. The explicit object literal (rather than
 * a mapped/`fromEntries` build) is deliberate: it keeps each tool name as a
 * literal key so `ChatUITools` and the `chat-tools.ts` policy record stay
 * exhaustively typed over these names.
 */
export const createFolioAgentDocTools = () => {
  const definitions = getFolioToolDefinitions();

  return {
    [READ_DOCUMENT_TOOL_NAME]: autoRunDocTool(
      definitions,
      READ_DOCUMENT_TOOL_NAME,
    ),
    [GET_DOCUMENT_OUTLINE_TOOL_NAME]: autoRunDocTool(
      definitions,
      GET_DOCUMENT_OUTLINE_TOOL_NAME,
    ),
    [READ_SECTION_TOOL_NAME]: autoRunDocTool(
      definitions,
      READ_SECTION_TOOL_NAME,
    ),
    [LIST_STORIES_TOOL_NAME]: autoRunDocTool(
      definitions,
      LIST_STORIES_TOOL_NAME,
    ),
    [READ_STORY_TOOL_NAME]: autoRunDocTool(definitions, READ_STORY_TOOL_NAME),
    [FIND_TEXT_TOOL_NAME]: autoRunDocTool(definitions, FIND_TEXT_TOOL_NAME),
    [READ_CHANGES_TOOL_NAME]: autoRunDocTool(
      definitions,
      READ_CHANGES_TOOL_NAME,
    ),
    [READ_COMMENTS_TOOL_NAME]: autoRunDocTool(
      definitions,
      READ_COMMENTS_TOOL_NAME,
    ),
    [SHOW_IN_DOCUMENT_TOOL_NAME]: autoRunDocTool(
      definitions,
      SHOW_IN_DOCUMENT_TOOL_NAME,
    ),
    [ADD_COMMENT_TOOL_NAME]: approvalDocTool(
      definitions,
      ADD_COMMENT_TOOL_NAME,
    ),
    [REPLY_COMMENT_TOOL_NAME]: approvalDocTool(
      definitions,
      REPLY_COMMENT_TOOL_NAME,
    ),
    [RESOLVE_COMMENT_TOOL_NAME]: approvalDocTool(
      definitions,
      RESOLVE_COMMENT_TOOL_NAME,
    ),
  };
};

/**
 * The `suggest_changes` tool shaped for one review surface. Queue-only on
 * both client surfaces (the bridge never writes), hence no approval gate:
 * the meaningful human gate is the per-suggestion Accept, not a chat-level
 * approval click. `chat-tools.ts` relaxes the contract's `mutation` policy
 * to `internal` for exactly this registration.
 */
export const createSuggestChangesTools = (surface: DocxSuggestionSurface) => {
  const definitions = getFolioToolDefinitions({
    suggestChanges: DOCX_SUGGEST_CHANGES_OPTIONS_BY_SURFACE[surface],
  });

  return {
    [SUGGEST_CHANGES_TOOL_NAME]: autoRunDocTool(
      definitions,
      SUGGEST_CHANGES_TOOL_NAME,
    ),
  };
};
