import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedUserFileId } from "@/api/lib/safe-id-boundaries";

export const USER_FILE_URL_PREFIX = "stella://file::" as const;

export type UserFileUrl = `${typeof USER_FILE_URL_PREFIX}${string}`;

export type UserFileViews = {
  simple: string;
  original?: string;
  trackedChanges?: string;
};

export const toUserFileUrl = (id: SafeId<"userFile">): UserFileUrl =>
  `${USER_FILE_URL_PREFIX}${id}`;

export const parseUserFileId = (url: string): SafeId<"userFile"> | null => {
  if (!url.startsWith(USER_FILE_URL_PREFIX)) {
    return null;
  }

  const id = url.slice(USER_FILE_URL_PREFIX.length);
  return id.length > 0 ? brandPersistedUserFileId(id) : null;
};

export const isUserFileUrl = (url: string): url is UserFileUrl =>
  parseUserFileId(url) !== null;
