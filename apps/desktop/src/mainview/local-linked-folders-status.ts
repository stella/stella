/**
 * The folders linked for this computer's local runs, as the native side
 * reports them (`local_linked_folders::LinkedFolderStatus`).
 */

export const LOCAL_LINKED_FOLDERS_CHANGED_EVENT =
  "local-linked-folders-changed";

const LINKED_FOLDER_STATES = [
  "available",
  "offline",
  "moved",
  "protected",
  "unreadable",
] as const;
export type LinkedFolderState = (typeof LINKED_FOLDER_STATES)[number];

const LIST_ERRORS = [
  "too_many",
  "not_a_folder",
  "network_folder",
  "protected",
  "unreadable",
] as const;

export type LinkedFolderNotice = (typeof LIST_ERRORS)[number] | "action_failed";

export type LinkedFolderStatus = {
  id: string;
  name: string;
  path: string;
  state: LinkedFolderState;
};

const isState = (value: unknown): value is LinkedFolderState =>
  LINKED_FOLDER_STATES.some((state) => state === value);

const isLinkedFolderStatus = (value: unknown): value is LinkedFolderStatus =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "name" in value &&
  typeof value.name === "string" &&
  "path" in value &&
  typeof value.path === "string" &&
  "state" in value &&
  isState(value.state);

export const isLinkedFolderList = (
  value: unknown,
): value is readonly LinkedFolderStatus[] =>
  Array.isArray(value) && value.every(isLinkedFolderStatus);

/** What to say about a refused command; Tauri rejects with its flat code. */
export const linkedFolderNotice = (code: unknown): LinkedFolderNotice =>
  LIST_ERRORS.find((known) => known === code) ?? "action_failed";
