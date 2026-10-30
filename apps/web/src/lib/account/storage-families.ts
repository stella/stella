import { Result } from "better-result";

import { mergeLegacyLawHistory } from "@/lib/account/law-history-legacy-merge";
import {
  CLAIMED_GUEST_ANNOTATIONS_STORAGE_KEY,
  DOCX_OUTLINE_DEPTH_STORAGE_KEY,
  GUEST_ANNOTATIONS_STORAGE_KEY,
  LAW_HISTORY_STORAGE_KEY,
  LEGACY_GUEST_ANNOTATIONS_STORAGE_KEY,
  MCP_OAUTH_REQUEST_STORAGE_KEY,
  READER_PROVISION_MODE_STORAGE_KEY,
} from "@/lib/account/storage-keys";

export type StorageArea = "local" | "session";

/** How to tell whose entry a key is. */
type OwnerReading =
  /** Keyed by this module: `<base>:u:<userId>` or `<base>:visitor`. */
  | "scoped"
  /**
   * Not keyed by owner: held for whoever the tab is signed in as, carried
   * from a visitor into the account they sign in to, and dropped when a
   * signed-in user leaves.
   */
  | "carried";

/**
 * What happens to a user's entry when they leave the browser (sign out, or
 * another account signs in):
 * - "kept-for-owner": the user's own work or choices (history, drafts,
 *   preferences, layout). It stays under their per-user key for when they
 *   come back; nobody else's key ever names it, so no one else reads it.
 * - "cleared": anything that holds fetched organization data, grants,
 *   approvals or work in flight. It goes when its owner leaves.
 */
type Retention = "kept-for-owner" | "cleared";

/**
 * How an entry written before entries were keyed by owner is named:
 * - "bare": the key is the family's prefix itself;
 * - "base": the key is the base a per-user key is now built on;
 * - "user-suffix": the key is that base followed by the user id it was
 *   written for (`<base><userId>`, the base being the prefix or running to
 *   the last `:`), so only that user takes it over.
 */
type LegacyKeys = "bare" | "base" | "user-suffix";

type Legacy = {
  keys: LegacyKeys;
  /**
   * What of the old entry goes into the user's own entry (`existing`, `null`
   * when they have none): the value to store, or `null` to leave theirs as
   * it is. The old entry stays until a user it can belong to signs in.
   */
  adopt: (raw: string, existing: string | null) => string | null;
};

/** Every new persistence family must decide whether safe boot resets it. */
export type StorageFamilyBase = {
  area: StorageArea;
  prefix: string;
  restoration: "layout" | "data";
};

type UserStorageFamily =
  | (StorageFamilyBase & {
      owner: Extract<OwnerReading, "scoped">;
      retention: Extract<Retention, "kept-for-owner">;
      legacy?: Legacy | undefined;
    })
  | (StorageFamilyBase & {
      owner: Extract<OwnerReading, "scoped">;
      retention: Extract<Retention, "cleared">;
      // Nothing cleared on leaving is worth taking over from before keying.
      legacy?: never;
    })
  | (StorageFamilyBase & {
      owner: Extract<OwnerReading, "carried">;
      retention: Extract<Retention, "cleared">;
      legacy?: never;
    });

/** The old entry, unless the user already has their own. */
const keepUnlessSet = (raw: string, existing: string | null) =>
  existing === null ? raw : null;

/**
 * The fields of a persisted store's entry worth taking over, or `null` when
 * the entry holds none or the user already has their own. Typed `unknown` on
 * purpose: it reads stored JSON.
 */
const keepPersistedFields =
  (fields: readonly string[]) =>
  (raw: string, existing: string | null): string | null => {
    if (existing !== null) {
      return null;
    }
    const parsed = Result.try((): unknown => JSON.parse(raw)).unwrapOr(null);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("state" in parsed) ||
      typeof parsed.state !== "object" ||
      parsed.state === null
    ) {
      return null;
    }
    const { state } = parsed;
    const kept = Object.fromEntries(
      Object.entries(state).filter(([field]) => fields.includes(field)),
    );
    if (Object.keys(kept).length === 0) {
      return null;
    }
    const version = "version" in parsed ? parsed.version : undefined;
    return JSON.stringify({ state: kept, version });
  };

const readStrings = (raw: string | null): readonly string[] => {
  const parsed =
    raw === null
      ? null
      : Result.try((): unknown => JSON.parse(raw)).unwrapOr(null);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
};

/** The user's own list, then whatever the old list adds, without repeats. */
const mergeStringLists = (raw: string, existing: string | null) => {
  const own = readStrings(existing);
  const added = readStrings(raw).filter((item) => !own.includes(item));
  return added.length === 0
    ? null
    : JSON.stringify([...new Set([...own, ...added])]);
};

/**
 * Every kind of entry that belongs to one user, each with what it keeps when
 * its owner leaves and why.
 */
export const USER_STORAGE_FAMILIES: readonly UserStorageFamily[] = [
  // A reading preference in the legal reader.
  {
    area: "local",
    prefix: READER_PROVISION_MODE_STORAGE_KEY,
    restoration: "data",
    owner: "scoped",
    retention: "kept-for-owner",
  },
  // The user's preferred heading depth in DOCX outlines.
  {
    area: "local",
    prefix: DOCX_OUTLINE_DEPTH_STORAGE_KEY,
    restoration: "layout",
    owner: "scoped",
    retention: "kept-for-owner",
  },
  // The user's own public-law searches and opened decisions and statutes.
  {
    area: "local",
    prefix: LAW_HISTORY_STORAGE_KEY,
    restoration: "data",
    owner: "scoped",
    retention: "kept-for-owner",
    legacy: { keys: "bare", adopt: mergeLegacyLawHistory },
  },
  // Instructions the user wrote for organizing a workspace's files.
  {
    area: "local",
    prefix: "stella.organize-suggestions.user-instructions.",
    restoration: "data",
    owner: "scoped",
    retention: "kept-for-owner",
    legacy: { keys: "base", adopt: keepUnlessSet },
  },
  // The chosen default send mode and per-chat send modes: preferences.
  {
    area: "local",
    prefix: "stella.chat.anonymized",
    restoration: "data",
    owner: "scoped",
    retention: "kept-for-owner",
    // The chosen default only; the per-chat modes name one user's chats.
    legacy: { keys: "bare", adopt: keepPersistedFields(["defaultSendMode"]) },
  },
  // The skill each main-area chat runs with: the user's choice per chat.
  {
    area: "local",
    prefix: "stella.chat.threadActiveSkill",
    restoration: "data",
    owner: "scoped",
    retention: "kept-for-owner",
  },
  // Report exports still running: work in flight on organization data.
  {
    area: "local",
    prefix: "stella.report-exports.active",
    restoration: "data",
    owner: "scoped",
    retention: "cleared",
  },
  // Dismissed connection breaks belong to the signed-in user's integrations.
  {
    area: "local",
    prefix: "stella:mcp-reconnect-dismissed:",
    restoration: "data",
    owner: "scoped",
    retention: "cleared",
  },
  // Tools the user approved for every chat: a standing grant.
  {
    area: "local",
    prefix: "stella.chat.alwaysApprovedTools",
    restoration: "data",
    owner: "scoped",
    retention: "cleared",
  },
  // Open inspector tabs, which name organization documents.
  {
    area: "local",
    prefix: "stella:inspector-state:v1:",
    restoration: "layout",
    owner: "scoped",
    retention: "cleared",
  },
  // Restored inspector tabs that have not yet settled in this tab: a
  // short-lived safety flag, gone when its owner leaves.
  {
    area: "session",
    prefix: "stella:inspector-restore-pending:v1:",
    restoration: "layout",
    owner: "scoped",
    retention: "cleared",
  },
  // Whether the inspector is minimized: a layout choice.
  {
    area: "local",
    prefix: "stella:inspector-minimized:v1:",
    restoration: "layout",
    owner: "scoped",
    retention: "kept-for-owner",
    legacy: { keys: "user-suffix", adopt: keepUnlessSet },
  },
  // Queries the user typed in workspace search: their own history.
  {
    area: "local",
    prefix: "stella-search-recent-searches:",
    restoration: "data",
    owner: "scoped",
    retention: "kept-for-owner",
    legacy: { keys: "user-suffix", adopt: keepUnlessSet },
  },
  // Recently opened files, with titles and workspace names fetched from
  // the organization.
  {
    area: "local",
    prefix: "stella-search-recent-files:",
    restoration: "data",
    owner: "scoped",
    retention: "cleared",
  },
  // Which matters the user pinned in the sidebar (ids only).
  {
    area: "local",
    prefix: "sidebar_pinned",
    restoration: "data",
    owner: "scoped",
    retention: "kept-for-owner",
    legacy: { keys: "user-suffix", adopt: mergeStringLists },
  },
  // Table column sizes and content modes: layout choices.
  {
    area: "local",
    prefix: "stella:table",
    restoration: "layout",
    owner: "scoped",
    retention: "kept-for-owner",
    legacy: { keys: "bare", adopt: keepUnlessSet },
  },
  // File tree column widths: layout choices.
  {
    area: "local",
    prefix: "stella.tree-view.column-widths.",
    restoration: "layout",
    owner: "scoped",
    retention: "kept-for-owner",
    legacy: { keys: "base", adopt: keepUnlessSet },
  },
  // How the user starts a review of one document: a preference.
  {
    area: "local",
    prefix: "document_review_start_mode_",
    restoration: "data",
    owner: "scoped",
    retention: "kept-for-owner",
    legacy: { keys: "base", adopt: keepUnlessSet },
  },
  // A contact import in flight, holding organization data.
  {
    area: "session",
    prefix: "contact-import-request:v1:",
    restoration: "data",
    owner: "scoped",
    retention: "cleared",
  },
  // A question drafted on a provision; not keyed by owner, so it cannot
  // wait for its owner and goes when a signed-in user leaves.
  {
    area: "session",
    prefix: "stella.provision-question:",
    restoration: "data",
    owner: "carried",
    retention: "cleared",
  },
  // A visitor's private legal-reader marks, until the first account signed in
  // this tab claims them; unclaimed, they go when that account leaves.
  {
    area: "session",
    prefix: GUEST_ANNOTATIONS_STORAGE_KEY,
    restoration: "data",
    owner: "carried",
    retention: "cleared",
  },
  // The previous guest-store shape follows the same ownership boundary until
  // the reader migrates it to the current shape.
  {
    area: "session",
    prefix: LEGACY_GUEST_ANNOTATIONS_STORAGE_KEY,
    restoration: "data",
    owner: "carried",
    retention: "cleared",
  },
  // Guest marks an account claimed and has not uploaded yet: they wait under
  // its key through a sign-out for its next sign-in in this tab, and no other
  // account reads them.
  {
    area: "session",
    prefix: CLAIMED_GUEST_ANNOTATIONS_STORAGE_KEY,
    restoration: "data",
    owner: "scoped",
    retention: "kept-for-owner",
  },
  // A desktop app's linking challenge, held across the sign-in redirect
  // until the desktop settings page consumes it once.
  {
    area: "session",
    prefix: "stella.desktop-account-link",
    restoration: "data",
    owner: "carried",
    retention: "cleared",
  },
  // One popup's authorization request, consumed when its callback returns.
  {
    area: "session",
    prefix: MCP_OAUTH_REQUEST_STORAGE_KEY,
    restoration: "data",
    owner: "carried",
    retention: "cleared",
  },
  // Tools approved for one conversation: a grant.
  {
    area: "session",
    prefix: "stella.chat.conversationApprovedTools:",
    restoration: "data",
    owner: "scoped",
    retention: "cleared",
  },
  // How browser actions are approved: an approval policy.
  {
    area: "session",
    prefix: "stella.chat.browserApprovalMode",
    restoration: "data",
    owner: "scoped",
    retention: "cleared",
  },
];

export const DEVICE_STORAGE_FAMILIES = [
  { area: "local", prefix: "stella:web-hang:", restoration: "data" },
  { area: "local", prefix: "statute_table_layout", restoration: "layout" },
  { area: "local", prefix: "case_law_hidden_columns", restoration: "layout" },
  { area: "local", prefix: "reader_text_scale", restoration: "layout" },
  { area: "local", prefix: "stella-ui-theme", restoration: "data" },
  { area: "local", prefix: "stella-ui-palette", restoration: "data" },
  {
    area: "local",
    prefix: "document_translation_last_target",
    restoration: "data",
  },
  { area: "local", prefix: "folio:debug-scroll", restoration: "data" },
  {
    area: "local",
    prefix: "stella:selfhost-update-dismissed:",
    restoration: "data",
  },
  { area: "local", prefix: "stella.templates.density", restoration: "layout" },
  { area: "local", prefix: "stella-dev", restoration: "data" },
  { area: "local", prefix: "stella.session-signal", restoration: "data" },
  {
    area: "local",
    prefix: "stella:chat-turn-notifications",
    restoration: "data",
  },
  {
    area: "local",
    prefix: "stella:inspector-pane-width:",
    restoration: "layout",
  },
  { area: "session", prefix: "stella:preload-reload-at", restoration: "data" },
  {
    area: "session",
    prefix: "stella.devQuickStart.attempt",
    restoration: "data",
  },
  { area: "session", prefix: "stella.storage-owner", restoration: "data" },
] as const satisfies readonly StorageFamilyBase[];
