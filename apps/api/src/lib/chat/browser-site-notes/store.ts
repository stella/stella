import { panic, Result } from "better-result";
import { and, asc, countDistinct, desc, eq, inArray, sql } from "drizzle-orm";

import { browserSiteGrantOrigin } from "@stll/api-contract/browser-site-grants";
import {
  BROWSER_SITE_NOTE_REFUSAL_CODE,
  BROWSER_SITE_NOTE_SITES_MAX,
  BROWSER_SITE_NOTES_PER_SITE_MAX,
  type BrowserSiteNote,
  type BrowserSiteNoteChange,
  type BrowserSiteNoteContent,
  browserSiteNoteContentRefusal,
  type BrowserSiteNoteRefusalCode,
  type SaveBrowserSiteNotesOutput,
} from "@stll/api-contract/browser-site-notes";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db-types";
import { chatBrowserSiteNotes } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { lockChatOwnerStoredContentTransitionOnTx } from "@/api/lib/chat/thread-stored-content-egress";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { holdMemberAccessOnTx } from "@/api/lib/db/member-access-hold";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  containsModelRoleControlTokens,
  stripPromptUnsafeChars,
} from "@/api/lib/prompt-safety";

/** The member a site note belongs to, from the authenticated session. */
export type BrowserSiteNoteOwner = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** Who changed a note, kept in its audit entry. */
type BrowserSiteNoteActor = "agent" | "member";

type StoredNote = {
  id: SafeId<"chatBrowserSiteNote">;
  kind: BrowserSiteNote["kind"];
  step: string;
  text: string;
  confirmedAt: Date;
  createdAt: Date;
};

const noteColumns = {
  id: chatBrowserSiteNotes.id,
  kind: chatBrowserSiteNotes.kind,
  step: chatBrowserSiteNotes.step,
  text: chatBrowserSiteNotes.text,
  confirmedAt: chatBrowserSiteNotes.confirmedAt,
  createdAt: chatBrowserSiteNotes.createdAt,
};

const ownedBy = ({ organizationId, userId }: BrowserSiteNoteOwner) =>
  and(
    eq(chatBrowserSiteNotes.organizationId, organizationId),
    eq(chatBrowserSiteNotes.userId, userId),
  );

const onSite = (owner: BrowserSiteNoteOwner, origin: string) =>
  and(ownedBy(owner), eq(chatBrowserSiteNotes.origin, origin));

// The most recently confirmed first; among notes confirmed at once, the
// newest written first, then by id so the order is total.
const readOrder = [
  desc(chatBrowserSiteNotes.confirmedAt),
  desc(chatBrowserSiteNotes.createdAt),
  desc(chatBrowserSiteNotes.id),
] as const;

/** A note as the agent and Settings read it, with its stored id. */
export type BrowserSiteNoteView = Omit<BrowserSiteNote, "id"> & {
  id: SafeId<"chatBrowserSiteNote">;
};

const toNote = (row: StoredNote): BrowserSiteNoteView => ({
  id: row.id,
  kind: row.kind,
  step: row.step,
  text: row.text,
  confirmedAt: row.confirmedAt.toISOString(),
});

const readSiteRows = async (
  tx: Transaction,
  owner: BrowserSiteNoteOwner,
  origin: string,
): Promise<StoredNote[]> => {
  const read = await readBounded(
    tx
      .select(noteColumns)
      .from(chatBrowserSiteNotes)
      .where(onSite(owner, origin))
      .orderBy(...readOrder),
    BROWSER_SITE_NOTES_PER_SITE_MAX,
  );
  // Every save prunes past the cap in the transaction that wrote the note.
  if (read.type === "overflow") {
    return panic("Stored site notes exceed their per-website cap");
  }
  return read.rows;
};

/** The notes the member keeps for the website `origin` names. */
export const readBrowserSiteNotes = async ({
  origin,
  owner,
  safeDb,
}: {
  origin: string;
  owner: BrowserSiteNoteOwner;
  safeDb: SafeDb;
}): Promise<Result<BrowserSiteNoteView[], SafeDbError>> =>
  await safeDb(async (tx) =>
    (await readSiteRows(tx, owner, origin)).map(toNote),
  );

/** A website the member keeps notes for, and how many. */
export type NotedBrowserSite = {
  origin: string;
  notes: BrowserSiteNoteView[];
};

/**
 * Every website the member keeps notes for, with its notes, by origin. At
 * most `BROWSER_SITE_NOTE_SITES_MAX` websites with at most
 * `BROWSER_SITE_NOTES_PER_SITE_MAX` notes each, so it is one page.
 */
export const listNotedBrowserSites = async ({
  owner,
  safeDb,
}: {
  owner: BrowserSiteNoteOwner;
  safeDb: SafeDb;
}): Promise<Result<NotedBrowserSite[], SafeDbError>> =>
  await safeDb(async (tx) => {
    const read = await readBounded(
      tx
        .select({ ...noteColumns, origin: chatBrowserSiteNotes.origin })
        .from(chatBrowserSiteNotes)
        .where(ownedBy(owner))
        .orderBy(asc(chatBrowserSiteNotes.origin), ...readOrder),
      BROWSER_SITE_NOTE_SITES_MAX * BROWSER_SITE_NOTES_PER_SITE_MAX,
    );
    if (read.type === "overflow") {
      return panic("Stored site notes exceed their per-member cap");
    }
    const sites = new Map<string, BrowserSiteNoteView[]>();
    for (const row of read.rows) {
      const notes = sites.get(row.origin);
      if (notes === undefined) {
        sites.set(row.origin, [toNote(row)]);
      } else {
        notes.push(toNote(row));
      }
    }
    return [...sites].map(([origin, notes]) => ({ origin, notes }));
  });

/**
 * The origins of the websites the member keeps notes for, so a prompt names
 * them without reading the notes.
 */
export const listNotedBrowserOrigins = async ({
  owner,
  safeDb,
}: {
  owner: BrowserSiteNoteOwner;
  safeDb: SafeDb;
}): Promise<Result<string[], SafeDbError>> =>
  await safeDb(async (tx) => {
    const read = await readBounded(
      tx
        .selectDistinct({ origin: chatBrowserSiteNotes.origin })
        .from(chatBrowserSiteNotes)
        .where(ownedBy(owner))
        .orderBy(asc(chatBrowserSiteNotes.origin)),
      BROWSER_SITE_NOTE_SITES_MAX,
    );
    if (read.type === "overflow") {
      return panic("Stored site notes exceed their per-member website cap");
    }
    return read.rows.map(({ origin }) => origin);
  });

type CleanContent =
  | { type: "clean"; content: BrowserSiteNoteContent }
  | { type: "refused"; code: BrowserSiteNoteRefusalCode; reason: string };

const cleanText = (text: string) =>
  stripPromptUnsafeChars(text).replaceAll(/\s+/gu, " ").trim();

/**
 * The note as it is kept, or why it is not: invisible and control characters
 * dropped and whitespace collapsed (a note is one line wherever it shows),
 * then refused when it carries model-control sequences or anything that is
 * not about the website (`browserSiteNoteContentRefusal`).
 */
export const cleanBrowserSiteNoteContent = (
  content: BrowserSiteNoteContent,
): CleanContent => {
  const step = cleanText(content.step);
  const text = cleanText(content.text);
  if (
    step.length === 0 ||
    text.length === 0 ||
    containsModelRoleControlTokens(step) ||
    containsModelRoleControlTokens(text)
  ) {
    return {
      type: "refused",
      code: BROWSER_SITE_NOTE_REFUSAL_CODE.unsafeText,
      reason:
        "A site note must be plain text about the website, without control or model-instruction sequences.",
    };
  }
  const refusal =
    browserSiteNoteContentRefusal(step) ?? browserSiteNoteContentRefusal(text);
  if (refusal !== null) {
    return { type: "refused", ...refusal };
  }
  return { type: "clean", content: { kind: content.kind, step, text } };
};

const sameContent = (note: StoredNote, content: BrowserSiteNoteContent) =>
  note.kind === content.kind &&
  note.step === content.step &&
  note.text === content.text;

/** Why a whole save was refused before any change was applied. */
export type SaveBrowserSiteNotesRefusal =
  { type: "not-https" } | { type: "not-member" };

type SaveOptions = {
  actor: BrowserSiteNoteActor;
  changes: readonly BrowserSiteNoteChange[];
  owner: BrowserSiteNoteOwner;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  url: string;
};

/** One save's view of a website's notes, inside its transaction. */
type SiteWrite = {
  tx: Transaction;
  owner: BrowserSiteNoteOwner;
  origin: string;
  recordAuditEvent: AuditRecorder;
  /** Keyed by the id as text: a change names a note by the id it read. */
  notes: Map<string, StoredNote>;
  /** Whether a first note for this website fits under the website cap. */
  siteHasRoom: () => Promise<boolean>;
};

type NoteAuditCause = BrowserSiteNoteActor | "pruned";

const noteAuditEvent = (
  action: (typeof AUDIT_ACTION)["CREATE" | "UPDATE" | "DELETE"],
  origin: string,
  note: Pick<StoredNote, "id" | "kind">,
  cause: NoteAuditCause,
) => ({
  action,
  resourceType: AUDIT_RESOURCE_TYPE.CHAT_BROWSER_SITE_NOTE,
  resourceId: note.id,
  workspaceId: null,
  metadata: { browserOrigin: origin, noteKind: note.kind, cause },
});

const noteOnSite = (
  { owner, origin }: SiteWrite,
  noteId: SafeId<"chatBrowserSiteNote">,
) => and(onSite(owner, origin), eq(chatBrowserSiteNotes.id, noteId));

const confirmNote = async (site: SiteWrite, note: StoredNote) => {
  // audit: skip - a confirmation only moves the note's confirmation time
  const updated =
    (
      await site.tx
        .update(chatBrowserSiteNotes)
        .set({ confirmedAt: sql`now()` })
        .where(noteOnSite(site, note.id))
        .returning(noteColumns)
    ).at(0) ?? panic("A held site note vanished under its lock");
  site.notes.set(updated.id, updated);
};

const removeNote = async (
  site: SiteWrite,
  note: StoredNote,
  cause: NoteAuditCause,
) => {
  const { origin, recordAuditEvent, tx } = site;
  await tx.delete(chatBrowserSiteNotes).where(noteOnSite(site, note.id));
  site.notes.delete(note.id);
  await recordAuditEvent(
    tx,
    noteAuditEvent(AUDIT_ACTION.DELETE, origin, note, cause),
  );
};

const insertNote = async (
  site: SiteWrite,
  content: BrowserSiteNoteContent,
  actor: BrowserSiteNoteActor,
) => {
  const { origin, owner, recordAuditEvent, tx } = site;
  const inserted =
    (
      await tx
        .insert(chatBrowserSiteNotes)
        .values({ ...owner, origin, ...content })
        .returning(noteColumns)
    ).at(0) ?? panic("A site note insert returned no row");
  site.notes.set(inserted.id, inserted);
  await recordAuditEvent(
    tx,
    noteAuditEvent(AUDIT_ACTION.CREATE, origin, inserted, actor),
  );
};

const rewriteNote = async (
  site: SiteWrite,
  note: StoredNote,
  content: BrowserSiteNoteContent,
  actor: BrowserSiteNoteActor,
) => {
  const { origin, recordAuditEvent, tx } = site;
  const replaced =
    (
      await tx
        .update(chatBrowserSiteNotes)
        .set({ ...content, confirmedAt: sql`now()` })
        .where(noteOnSite(site, note.id))
        .returning(noteColumns)
    ).at(0) ?? panic("A held site note vanished under its lock");
  site.notes.set(replaced.id, replaced);
  await recordAuditEvent(
    tx,
    noteAuditEvent(AUDIT_ACTION.UPDATE, origin, replaced, actor),
  );
};

type ChangeIssue = Omit<SaveBrowserSiteNotesOutput["issues"][number], "index">;

const UNKNOWN_NOTE: ChangeIssue = {
  code: BROWSER_SITE_NOTE_REFUSAL_CODE.unknownNote,
  reason:
    "No note with that id is kept for this website; call read_site_notes for the current ids.",
};

const keptNote = (site: SiteWrite, content: BrowserSiteNoteContent) =>
  [...site.notes.values()].find((note) => sameContent(note, content));

/** Applies one change; a refused change answers why, an applied one null. */
const applyChange = async (
  site: SiteWrite,
  change: BrowserSiteNoteChange,
  actor: BrowserSiteNoteActor,
): Promise<ChangeIssue | null> => {
  if (change.type === "confirm" || change.type === "remove") {
    const note = site.notes.get(change.id);
    if (note === undefined) {
      return UNKNOWN_NOTE;
    }
    await (change.type === "confirm"
      ? confirmNote(site, note)
      : removeNote(site, note, actor));
    return null;
  }
  const cleaned = cleanBrowserSiteNoteContent(change);
  if (cleaned.type === "refused") {
    return { code: cleaned.code, reason: cleaned.reason };
  }
  const { content } = cleaned;
  const existing = keptNote(site, content);
  if (change.type === "add") {
    if (existing !== undefined) {
      await confirmNote(site, existing);
      return null;
    }
    if (!(await site.siteHasRoom())) {
      return {
        code: BROWSER_SITE_NOTE_REFUSAL_CODE.siteLimitReached,
        reason: `Notes are kept for at most ${String(BROWSER_SITE_NOTE_SITES_MAX)} websites; the member can remove some in Settings, Connections.`,
      };
    }
    await insertNote(site, content, actor);
    return null;
  }
  change.type satisfies "replace";
  const note = site.notes.get(change.id);
  if (note === undefined) {
    return UNKNOWN_NOTE;
  }
  if (existing === undefined) {
    await rewriteNote(site, note, content, actor);
    return null;
  }
  // What replaces the note is already kept: keep that one, confirmed.
  if (existing.id !== note.id) {
    await removeNote(site, note, actor);
  }
  await confirmNote(site, existing);
  return null;
};

/**
 * Drops the least recently confirmed notes past the per-website cap and
 * answers the notes kept, the most recently confirmed first, and the ids
 * dropped.
 */
const pruneSite = async (site: SiteWrite) => {
  const { origin, recordAuditEvent, tx } = site;
  const ordered = [...site.notes.values()].toSorted(
    (a, b) =>
      b.confirmedAt.getTime() - a.confirmedAt.getTime() ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.id < b.id ? 1 : -1),
  );
  const pruned = ordered.slice(BROWSER_SITE_NOTES_PER_SITE_MAX);
  if (pruned.length > 0) {
    await tx.delete(chatBrowserSiteNotes).where(
      and(
        onSite(site.owner, origin),
        inArray(
          chatBrowserSiteNotes.id,
          pruned.map(({ id }) => id),
        ),
      ),
    );
    for (const note of pruned) {
      await recordAuditEvent(
        tx,
        noteAuditEvent(AUDIT_ACTION.DELETE, origin, note, "pruned"),
      );
    }
  }
  return {
    kept: ordered.slice(0, BROWSER_SITE_NOTES_PER_SITE_MAX),
    pruned: pruned.map(({ id }) => id),
  };
};

const countNotedSites = async (tx: Transaction, owner: BrowserSiteNoteOwner) =>
  (
    await tx
      .select({ sites: countDistinct(chatBrowserSiteNotes.origin) })
      .from(chatBrowserSiteNotes)
      .where(ownedBy(owner))
  ).at(0)?.sites ?? 0;

/**
 * Apply the agent's changes to the notes for the website `url` is on, in
 * order and each on its own: a refused change comes back in `issues` and the
 * others still apply. Adding a note already kept confirms it, and a
 * confirmation or replacement moves the note's confirmation time, so the
 * notes the agent keeps following stay and the cap prunes the rest, least
 * recently confirmed first. Creations, replacements and removals are
 * audited; a confirmation only moves a time.
 */
export const saveBrowserSiteNotes = async ({
  actor,
  changes,
  owner,
  recordAuditEvent,
  safeDb,
  url,
}: SaveOptions): Promise<
  Result<
    | { type: "saved"; output: SaveBrowserSiteNotesOutput }
    | { type: "refused"; refusal: SaveBrowserSiteNotesRefusal },
    SafeDbError
  >
> => {
  const origin = browserSiteGrantOrigin(url);
  if (origin === null) {
    return Result.ok({ type: "refused", refusal: { type: "not-https" } });
  }
  return await safeDb(async (tx) => {
    // Member removal takes this fence before it deletes the member's notes,
    // so a note either lands before the removal deletes it, or waits and
    // then finds the member gone.
    await lockChatOwnerStoredContentTransitionOnTx(tx, owner);
    const membership = await holdMemberAccessOnTx(tx, {
      ...owner,
      workspaceIds: [],
    });
    if (membership.type === "not-member") {
      return { type: "refused", refusal: { type: "not-member" } } as const;
    }
    // The member's per-user collection lock, shared with their approvals:
    // one writer at a time keeps the caps exact.
    await withAggregateLock({ tx, aggregate: "chatToolGrants", id: owner });

    const notes = new Map<string, StoredNote>(
      (await readSiteRows(tx, owner, origin)).map((note) => [note.id, note]),
    );
    // A website with notes is already counted; a first note asks once.
    let siteHasRoom: boolean | null = notes.size > 0 ? true : null;
    const site: SiteWrite = {
      tx,
      owner,
      origin,
      recordAuditEvent,
      notes,
      siteHasRoom: async () => {
        siteHasRoom ??=
          (await countNotedSites(tx, owner)) < BROWSER_SITE_NOTE_SITES_MAX;
        return siteHasRoom;
      },
    };
    const issues: SaveBrowserSiteNotesOutput["issues"] = [];
    for (const [index, change] of changes.entries()) {
      const issue = await applyChange(site, change, actor);
      if (issue !== null) {
        issues.push({ index, ...issue });
      }
    }
    const { kept, pruned } = await pruneSite(site);
    return {
      type: "saved",
      output: { origin, notes: kept.map(toNote), issues, pruned },
    } as const;
  });
};

/**
 * Remove one of the member's notes, from Settings. Idempotent: a note
 * already gone answers `deleted: false`.
 */
export const deleteBrowserSiteNote = async ({
  noteId,
  owner,
  recordAuditEvent,
  safeDb,
}: {
  noteId: SafeId<"chatBrowserSiteNote">;
  owner: BrowserSiteNoteOwner;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
}): Promise<Result<{ deleted: boolean }, SafeDbError>> =>
  await safeDb(async (tx) => {
    await withAggregateLock({ tx, aggregate: "chatToolGrants", id: owner });
    const rows = await tx
      .delete(chatBrowserSiteNotes)
      .where(and(ownedBy(owner), eq(chatBrowserSiteNotes.id, noteId)))
      .returning({
        id: chatBrowserSiteNotes.id,
        kind: chatBrowserSiteNotes.kind,
        origin: chatBrowserSiteNotes.origin,
      });
    for (const row of rows) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_BROWSER_SITE_NOTE,
        resourceId: row.id,
        workspaceId: null,
        metadata: {
          browserOrigin: row.origin,
          noteKind: row.kind,
          cause: "member",
        },
      });
    }
    return { deleted: rows.length > 0 };
  });

/**
 * Remove every note the member keeps for the website `url` is on, from
 * Settings (beside a website approval, or with it).
 */
export const deleteBrowserSiteNotesForSite = async ({
  owner,
  recordAuditEvent,
  safeDb,
  url,
}: {
  owner: BrowserSiteNoteOwner;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  url: string;
}): Promise<Result<{ deleted: number } | null, SafeDbError>> => {
  const origin = browserSiteGrantOrigin(url);
  if (origin === null) {
    return Result.ok(null);
  }
  return await safeDb(async (tx) => {
    await withAggregateLock({ tx, aggregate: "chatToolGrants", id: owner });
    const rows = await tx
      .delete(chatBrowserSiteNotes)
      .where(onSite(owner, origin))
      .returning({
        id: chatBrowserSiteNotes.id,
        kind: chatBrowserSiteNotes.kind,
      });
    for (const row of rows) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_BROWSER_SITE_NOTE,
        resourceId: row.id,
        workspaceId: null,
        metadata: {
          browserOrigin: origin,
          noteKind: row.kind,
          cause: "member",
        },
      });
    }
    return { deleted: rows.length };
  });
};

/** A note in the member's data export, as Settings shows it. */
export const toBrowserSiteNoteAccountExport = (
  row: typeof chatBrowserSiteNotes.$inferSelect,
) => ({
  id: row.id,
  origin: row.origin,
  kind: row.kind,
  step: row.step,
  text: row.text,
  createdAt: row.createdAt.toISOString(),
  confirmedAt: row.confirmedAt.toISOString(),
});
