export const EML_MIME_TYPE = "message/rfc822";
export const MSG_MIME_TYPE = "application/vnd.ms-outlook";

export const EMAIL_MIME_TYPES = {
  [EML_MIME_TYPE]: null,
  [MSG_MIME_TYPE]: null,
} as const satisfies Record<string, null>;

const EMAIL_EXTENSION_MIME_TYPES: Record<string, string> = {
  eml: EML_MIME_TYPE,
  msg: MSG_MIME_TYPE,
};

export const isEmailMimeType = (mimeType: string | null | undefined): boolean =>
  mimeType !== null &&
  mimeType !== undefined &&
  Object.hasOwn(EMAIL_MIME_TYPES, mimeType);

type ResolveEmailMimeTypeOptions = {
  fileName?: string | null | undefined;
  mimeType?: string | null | undefined;
};

/** The email MIME type a file carries, falling back to its extension. */
export const resolveEmailMimeType = ({
  fileName,
  mimeType,
}: ResolveEmailMimeTypeOptions): string | null => {
  if (
    mimeType !== null &&
    mimeType !== undefined &&
    isEmailMimeType(mimeType)
  ) {
    return mimeType;
  }
  const dotIndex = fileName?.lastIndexOf(".") ?? -1;
  if (!fileName || dotIndex === -1) {
    return null;
  }
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  return EMAIL_EXTENSION_MIME_TYPES[extension] ?? null;
};
