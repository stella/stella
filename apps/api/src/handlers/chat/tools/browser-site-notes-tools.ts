import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import type * as v from "valibot";

import { browserSiteGrantOrigin } from "@stll/api-contract/browser-site-grants";
import {
  BROWSER_SITE_NOTE_REFUSAL_CODE,
  browserSiteNotesSchema,
  LIST_SITE_NOTES_TOOL_NAME,
  readBrowserSiteNotesInputSchema,
  SAVE_SITE_NOTES_TOOL_NAME,
  saveBrowserSiteNotesInputSchema,
  type SaveBrowserSiteNotesOutput,
  saveBrowserSiteNotesOutputSchema,
} from "@stll/api-contract/browser-site-notes";

import type { SafeDb } from "@/api/db/safe-db-types";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { raiseChatToolError } from "@/api/handlers/chat/tools/tool-failure";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  LIST_SITE_NOTES_DESCRIPTION,
  SAVE_SITE_NOTES_DESCRIPTION,
} from "@/api/lib/chat/browser-site-notes/agent-surface";
import {
  type BrowserSiteNoteOwner,
  readBrowserSiteNotes,
  saveBrowserSiteNotes,
} from "@/api/lib/chat/browser-site-notes/store";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

type BrowserSiteNotes = v.InferOutput<typeof browserSiteNotesSchema>;
type SaveBrowserSiteNotesInput = v.InferOutput<
  typeof saveBrowserSiteNotesInputSchema
>;

const NOT_HTTPS_MESSAGE =
  "Pass the address of a page on the website as the browser reported it; only HTTPS websites keep notes.";

type CreateBrowserSiteNotesToolsProps = {
  owner: BrowserSiteNoteOwner;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
};

const readNotes = async (
  { owner, safeDb }: Omit<CreateBrowserSiteNotesToolsProps, "recordAuditEvent">,
  url: string,
): Promise<Result<BrowserSiteNotes, ChatToolError>> => {
  const origin = browserSiteGrantOrigin(url);
  if (origin === null) {
    return Result.err(
      new ChatToolError({ kind: "invalid-input", message: NOT_HTTPS_MESSAGE }),
    );
  }
  const notes = await readBrowserSiteNotes({ origin, owner, safeDb });
  if (Result.isError(notes)) {
    return Result.err(
      new ChatToolError({
        kind: "transient",
        message: "The website's notes could not be read; try again.",
        cause: notes.error,
      }),
    );
  }
  return Result.ok({ origin, notes: notes.value });
};

const saveNotes = async (
  { owner, recordAuditEvent, safeDb }: CreateBrowserSiteNotesToolsProps,
  { changes, url }: SaveBrowserSiteNotesInput,
): Promise<Result<SaveBrowserSiteNotesOutput, ChatToolError>> => {
  const saved = await saveBrowserSiteNotes({
    actor: "agent",
    changes,
    owner,
    recordAuditEvent,
    safeDb,
    url,
  });
  if (Result.isError(saved)) {
    return Result.err(
      new ChatToolError({
        kind: "transient",
        message: "The website's notes could not be saved; try again.",
        cause: saved.error,
      }),
    );
  }
  if (saved.value.type === "saved") {
    return Result.ok(saved.value.output);
  }
  return Result.err(
    saved.value.refusal.type === "not-https"
      ? new ChatToolError({
          kind: "invalid-input",
          message: `${BROWSER_SITE_NOTE_REFUSAL_CODE.notHttps}: ${NOT_HTTPS_MESSAGE}`,
        })
      : new ChatToolError({
          kind: "unavailable",
          message: "Notes are kept only for a member of the organization.",
        }),
  );
};

/**
 * The research-note tools beside chat's browser tool: read a website's notes
 * before browsing it, and keep them current after. They touch only the
 * member's own notes about how a website works, which the API refuses to
 * hold anything else in, so they run without asking; the browser step gate
 * still decides every step on the website.
 */
export const createBrowserSiteNotesTools = (
  props: CreateBrowserSiteNotesToolsProps,
) => ({
  [LIST_SITE_NOTES_TOOL_NAME]: toolDefinition({
    name: LIST_SITE_NOTES_TOOL_NAME,
    description: LIST_SITE_NOTES_DESCRIPTION,
    inputSchema: toTanStackToolSchema(readBrowserSiteNotesInputSchema),
    outputSchema: toTanStackToolSchema(browserSiteNotesSchema),
  }).server(async ({ url }) => {
    const read = await readNotes(props, url);
    return Result.isError(read) ? raiseChatToolError(read.error) : read.value;
  }),
  [SAVE_SITE_NOTES_TOOL_NAME]: toolDefinition({
    name: SAVE_SITE_NOTES_TOOL_NAME,
    description: SAVE_SITE_NOTES_DESCRIPTION,
    inputSchema: toTanStackToolSchema(saveBrowserSiteNotesInputSchema),
    outputSchema: toTanStackToolSchema(saveBrowserSiteNotesOutputSchema),
  }).server(async (input) => {
    const saved = await saveNotes(props, input);
    return Result.isError(saved)
      ? raiseChatToolError(saved.error)
      : saved.value;
  }),
});
