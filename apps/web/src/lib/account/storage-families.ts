import { Result } from "better-result";

import { READER_PROVISION_MODE_STORAGE_KEY } from "@/components/legal-reader/reader-provision-mode.logic";

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

type UserStorageFamily = {
  area: StorageArea;
  prefix: string;
  owner: OwnerReading;
  /**
   * An entry written before entries were keyed by owner (its key is the bare
   * prefix) is dropped, unless it holds a protective choice: then the first
   * user identified in this browser takes over the part `adopt` keeps, and
   * until then the entry stays.
   */
  legacy?: { adopt: (raw: string) => string | null } | undefined;
};

/**
 * The fields of a persisted store's entry worth taking over, or `null` when
 * the entry holds none. Typed `unknown` on purpose: it reads stored JSON.
 */
const keepPersistedFields =
  (fields: readonly string[]) =>
  (raw: string): string | null => {
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

/** Every kind of entry that belongs to one user. */
export const USER_STORAGE_FAMILIES: readonly UserStorageFamily[] = [
  { area: "local", prefix: READER_PROVISION_MODE_STORAGE_KEY, owner: "scoped" },
  { area: "local", prefix: "law_search_history", owner: "scoped" },
  {
    area: "local",
    prefix: "stella.organize-suggestions.user-instructions.",
    owner: "scoped",
  },
  {
    area: "local",
    prefix: "stella.chat.anonymized",
    owner: "scoped",
    // The chosen default only; the per-chat modes name one user's chats.
    legacy: { adopt: keepPersistedFields(["defaultSendMode"]) },
  },
  { area: "local", prefix: "stella.report-exports.active", owner: "scoped" },
  { area: "local", prefix: "stella.chat.alwaysApprovedTools", owner: "scoped" },
  { area: "local", prefix: "stella:inspector-state:v1:", owner: "scoped" },
  {
    area: "local",
    prefix: "stella:inspector-minimized:v1:",
    owner: "scoped",
  },
  {
    area: "local",
    prefix: "stella-search-recent-searches:",
    owner: "scoped",
  },
  {
    area: "local",
    prefix: "stella-search-recent-files:",
    owner: "scoped",
  },
  { area: "local", prefix: "sidebar_pinned", owner: "scoped" },
  { area: "local", prefix: "stella:table", owner: "scoped" },
  { area: "local", prefix: "stella.tree-view.column-widths.", owner: "scoped" },
  { area: "local", prefix: "document_review_start_mode_", owner: "scoped" },
  { area: "session", prefix: "contact-import-request:v1:", owner: "scoped" },
  { area: "session", prefix: "stella.provision-question:", owner: "carried" },
  {
    area: "session",
    prefix: "stella.chat.conversationApprovedTools:",
    owner: "scoped",
  },
  {
    area: "session",
    prefix: "stella.chat.browserApprovalMode",
    owner: "scoped",
  },
];

export const DEVICE_STORAGE_FAMILIES = [
  { area: "local", prefix: "stella-ui-theme" },
  { area: "local", prefix: "stella-ui-palette" },
  { area: "local", prefix: "sidebar_state" },
  { area: "local", prefix: "document_translation_last_target" },
  { area: "local", prefix: "folio:debug-scroll" },
  { area: "local", prefix: "stella:selfhost-update-dismissed:" },
  { area: "local", prefix: "stella.templates.density" },
  { area: "local", prefix: "stella-dev" },
  { area: "local", prefix: "stella.session-signal" },
  { area: "local", prefix: "stella:chat-turn-notifications" },
  { area: "session", prefix: "stella:preload-reload-at" },
  { area: "session", prefix: "stella.devQuickStart.attempt" },
  { area: "session", prefix: "stella.storage-owner" },
] as const satisfies readonly { area: StorageArea; prefix: string }[];
