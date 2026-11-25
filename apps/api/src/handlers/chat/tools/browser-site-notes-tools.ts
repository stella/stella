import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";

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

import type { SafeDb } from "@/api/db/safe-db-types";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  READ_SITE_NOTES_DESCRIPTION,
  SAVE_SITE_NOTES_DESCRIPTION,
} from "@/api/lib/chat/browser-site-notes/agent-surface";
import {
  type BrowserSiteNoteOwner,
  readBrowserSiteNotes,
  saveBrowserSiteNotes,
} from "@/api/lib/chat/browser-site-notes/store";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

export { READ_SITE_NOTES_TOOL_NAME, SAVE_SITE_NOTES_TOOL_NAME };

const NOT_HTTPS_MESSAGE =
  "Pass the address of a page on the website as the browser reported it; only HTTPS websites keep notes.";

type CreateBrowserSiteNotesToolsProps = {
  owner: BrowserSiteNoteOwner;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
};

/**
 * The research-note tools beside chat's browser tool: read a website's notes
 * before browsing it, and keep them current after. They touch only the
 * member's own notes about how a website works, which the API refuses to
 * hold anything else in, so they run without asking; the browser step gate
 * still decides every step on the website.
 */
export const createBrowserSiteNotesTools = ({
  owner,
  recordAuditEvent,
  safeDb,
}: CreateBrowserSiteNotesToolsProps) => ({
  [READ_SITE_NOTES_TOOL_NAME]: toolDefinition({
    name: READ_SITE_NOTES_TOOL_NAME,
    description: READ_SITE_NOTES_DESCRIPTION,
    inputSchema: toTanStackToolSchema(readBrowserSiteNotesInputSchema),
    outputSchema: toTanStackToolSchema(browserSiteNotesSchema),
  }).server(async ({ url }) => {
    const origin = browserSiteGrantOrigin(url);
    if (origin === null) {
      throw new ChatToolError({
        kind: "invalid-input",
        message: NOT_HTTPS_MESSAGE,
      });
    }
    const notes = await readBrowserSiteNotes({ origin, owner, safeDb });
    if (Result.isError(notes)) {
      throw new ChatToolError({
        kind: "transient",
        message: "The website's notes could not be read; try again.",
        cause: notes.error,
      });
    }
    return { origin, notes: notes.value };
  }),
  [SAVE_SITE_NOTES_TOOL_NAME]: toolDefinition({
    name: SAVE_SITE_NOTES_TOOL_NAME,
    description: SAVE_SITE_NOTES_DESCRIPTION,
    inputSchema: toTanStackToolSchema(saveBrowserSiteNotesInputSchema),
    outputSchema: toTanStackToolSchema(saveBrowserSiteNotesOutputSchema),
  }).server(async ({ changes, url }) => {
    const saved = await saveBrowserSiteNotes({
      actor: "agent",
      changes,
      owner,
      recordAuditEvent,
      safeDb,
      url,
    });
    if (Result.isError(saved)) {
      throw new ChatToolError({
        kind: "transient",
        message: "The website's notes could not be saved; try again.",
        cause: saved.error,
      });
    }
    if (saved.value.type === "refused") {
      const { refusal } = saved.value;
      throw refusal.type === "not-https"
        ? new ChatToolError({
            kind: "invalid-input",
            message: `${BROWSER_SITE_NOTE_REFUSAL_CODE.notHttps}: ${NOT_HTTPS_MESSAGE}`,
          })
        : new ChatToolError({
            kind: "unavailable",
            message: "Notes are kept only for a member of the organization.",
          });
    }
    return saved.value.output;
  }),
});
