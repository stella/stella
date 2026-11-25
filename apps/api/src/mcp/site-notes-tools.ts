import { Result } from "better-result";
import * as v from "valibot";

import { browserSiteGrantOrigin } from "@stll/api-contract/browser-site-grants";
import {
  BROWSER_SITE_NOTE_REFUSAL_CODE,
  browserSiteNotesSchema,
  READ_SITE_NOTES_TOOL_NAME,
  readBrowserSiteNotesInputSchema,
  SAVE_SITE_NOTES_TOOL_NAME,
  saveBrowserSiteNotesInputSchema,
  saveBrowserSiteNotesOutputSchema,
} from "@stll/api-contract/browser-site-notes";

import {
  READ_SITE_NOTES_DESCRIPTION,
  SAVE_SITE_NOTES_DESCRIPTION,
} from "@/api/lib/chat/browser-site-notes/agent-surface";
import {
  readBrowserSiteNotes,
  saveBrowserSiteNotes,
} from "@/api/lib/chat/browser-site-notes/store";

import { nullAsAbsent } from "./input-schemas";
import { defineMcpToolSet } from "./tool-types";
import type { TypedMcpToolHandler } from "./tool-types";
import {
  internalFailureResult,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "./tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "./valibot-tool-definition";

/**
 * The research-note tools for a coding agent on the member's computer (and
 * any MCP client that browses for the member): the same names, inputs and
 * descriptions as chat's own (`handlers/chat/tools/browser-site-notes-tools.ts`),
 * served over the stella MCP server because a run there reaches stella's
 * tools through it. The notes are kept server side, as the rest of a run's
 * content is.
 */

const readArgsSchema = nullAsAbsent(readBrowserSiteNotesInputSchema);
const saveArgsSchema = nullAsAbsent(saveBrowserSiteNotesInputSchema);

const NOT_HTTPS_HINT =
  "Pass the address of a page on the website as the browser reported it (https://...); only HTTPS websites keep notes.";

const definitions = [
  defineValibotMcpTool({
    name: READ_SITE_NOTES_TOOL_NAME,
    consumesServices: false,
    annotations: {
      title: "Read website research notes",
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description: READ_SITE_NOTES_DESCRIPTION,
    inputSchema: readArgsSchema,
    access: "read",
    permissions: { type: "all", permissions: { chat: ["create"] } },
    readClass: "tenant",
    // The API keeps no personal data, credential or search address in a
    // note (`browserSiteNoteContentRefusal`): what is left describes a
    // website's forms and filters.
    anonymized: { exposure: "passthrough" },
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    name: SAVE_SITE_NOTES_TOOL_NAME,
    consumesServices: false,
    annotations: {
      title: "Update website research notes",
      // A replacement rewrites a note and a removal deletes one.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: SAVE_SITE_NOTES_DESCRIPTION,
    inputSchema: saveArgsSchema,
    access: "write",
    accountAccess: "sandbox",
    permissions: { type: "all", permissions: { chat: ["create"] } },
    anonymized: { exposure: "excluded", reason: "write" },
    scope: "stella:knowledge_write",
  }),
] as const;

const handleReadSiteNotes: TypedMcpToolHandler<
  v.InferOutput<typeof browserSiteNotesSchema>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues, NOT_HTTPS_HINT);
  }
  const origin = browserSiteGrantOrigin(parsed.output.url);
  if (origin === null) {
    return structuredErrorResult({
      code: "validation_error",
      message: "The address is not a plain HTTPS one, so it names no website.",
      hint: NOT_HTTPS_HINT,
    });
  }
  const notes = await readBrowserSiteNotes({
    origin,
    owner: { organizationId: context.organizationId, userId: context.userId },
    safeDb: context.safeDb,
  });
  if (Result.isError(notes)) {
    return internalFailureResult(notes.error, "mcp.read_site_notes.read_error");
  }
  return toolDataResult({ origin, notes: notes.value });
};

const handleSaveSiteNotes: TypedMcpToolHandler<
  v.InferOutput<typeof saveBrowserSiteNotesOutputSchema>
> = async ({ args, context }) => {
  const parsed = v.safeParse(saveArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(
      parsed.issues,
      "Send the page address and a list of changes, each { type: add | confirm | replace | remove } with the fields its type takes.",
    );
  }
  const saved = await saveBrowserSiteNotes({
    actor: "agent",
    changes: parsed.output.changes,
    owner: { organizationId: context.organizationId, userId: context.userId },
    recordAuditEvent: context.recordAuditEvent,
    safeDb: context.safeDb,
    url: parsed.output.url,
  });
  if (Result.isError(saved)) {
    return internalFailureResult(saved.error, "mcp.save_site_notes.save_error");
  }
  if (saved.value.type === "refused") {
    return saved.value.refusal.type === "not-https"
      ? structuredErrorResult({
          code: "validation_error",
          message: `${BROWSER_SITE_NOTE_REFUSAL_CODE.notHttps}: the address is not a plain HTTPS one, so it names no website.`,
          hint: NOT_HTTPS_HINT,
        })
      : structuredErrorResult({
          code: "permission_denied",
          message: "Notes are kept only for a member of the organization.",
        });
  }
  return toolDataResult(saved.value.output);
};

export const SITE_NOTES_TOOL_HANDLERS = {
  [READ_SITE_NOTES_TOOL_NAME]: handleReadSiteNotes,
  [SAVE_SITE_NOTES_TOOL_NAME]: handleSaveSiteNotes,
};

export const SITE_NOTES_TOOL_SET = defineMcpToolSet(
  definitions,
  SITE_NOTES_TOOL_HANDLERS,
  {
    [READ_SITE_NOTES_TOOL_NAME]: defineMcpToolOutput(browserSiteNotesSchema),
    [SAVE_SITE_NOTES_TOOL_NAME]: defineMcpToolOutput(
      saveBrowserSiteNotesOutputSchema,
    ),
  },
);
