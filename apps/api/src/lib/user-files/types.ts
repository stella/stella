import { USER_FILE_URL_PREFIX, userFileIdFromUrl } from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedUserFileId } from "@/api/lib/safe-id-boundaries";

export type UserFileUrl = `${typeof USER_FILE_URL_PREFIX}${string}`;

export type UserFileViews = {
  simple: string;
  original?: string;
  trackedChanges?: string;
};

export const toUserFileUrl = (id: SafeId<"userFile">): UserFileUrl =>
  `${USER_FILE_URL_PREFIX}${id}`;

export const parseUserFileId = (url: string): SafeId<"userFile"> | null => {
  const id = userFileIdFromUrl(url);
  return id === null ? null : brandPersistedUserFileId(id);
};

export const isUserFileUrl = (url: string): url is UserFileUrl =>
  parseUserFileId(url) !== null;
