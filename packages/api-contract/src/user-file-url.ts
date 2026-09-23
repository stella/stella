export const USER_FILE_URL_PREFIX = "stella://file::";

/** The user-file id a `stella://file::` URL names, or null for any other URL. */
export const userFileIdFromUrl = (url: string): string | null => {
  if (!url.startsWith(USER_FILE_URL_PREFIX)) {
    return null;
  }
  const id = url.slice(USER_FILE_URL_PREFIX.length);
  return id.length > 0 ? id : null;
};
