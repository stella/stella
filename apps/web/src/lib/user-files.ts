import { apiUrl } from "@/lib/api-url";

const USER_FILE_URL_PREFIX = "stella://file::";

export const parseUserFileId = (url: string): string | null => {
  if (!url.startsWith(USER_FILE_URL_PREFIX)) {
    return null;
  }

  const fileId = url.slice(USER_FILE_URL_PREFIX.length);
  return fileId.length > 0 ? fileId : null;
};

export const getUserFileContentUrl = (url: string): string | null => {
  const fileId = parseUserFileId(url);
  if (fileId === null) {
    return null;
  }

  return apiUrl(`/user-files/${fileId}/content`);
};

export const getUserFileThumbnailUrl = (url: string): string | null => {
  const fileId = parseUserFileId(url);
  if (fileId === null) {
    return null;
  }

  return apiUrl(`/user-files/${fileId}/thumbnail`);
};
