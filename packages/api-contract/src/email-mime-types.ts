export const EML_MIME_TYPE = "message/rfc822";
export const MSG_MIME_TYPE = "application/vnd.ms-outlook";
/**
 * Outlook's Transport-Neutral Encapsulation Format: a message (its body,
 * its attachments, its MAPI properties) as Outlook sends it beside or
 * instead of a MIME message, usually as an attachment named `winmail.dat`.
 */
export const TNEF_MIME_TYPE = "application/vnd.ms-tnef";

/** Other media types a TNEF stream is declared as. */
export const TNEF_MIME_ALIASES = ["application/ms-tnef"] as const;

/** The name Outlook gives the TNEF stream it attaches to a message. */
const TNEF_FILE_NAME = "winmail.dat";

export const EMAIL_MIME_TYPES = {
  [EML_MIME_TYPE]: null,
  [MSG_MIME_TYPE]: null,
  [TNEF_MIME_TYPE]: null,
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

const isTnefMimeAlias = (mimeType: string): boolean =>
  TNEF_MIME_ALIASES.some(
    (alias) =>
      alias === (mimeType.split(";", 1).at(0) ?? "").trim().toLowerCase(),
  );

/** Whether a name is the one Outlook gives a TNEF stream, in any case. */
export const isTnefFileName = (fileName: string | null | undefined): boolean =>
  (fileName?.trim().split(/[/\\]/u).at(-1)?.toLowerCase() ?? "") ===
  TNEF_FILE_NAME;

/**
 * The email MIME type a file carries, falling back to its name: an `.eml`
 * or `.msg` extension, or the `winmail.dat` Outlook names a TNEF stream.
 */
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
  if (
    (mimeType !== null &&
      mimeType !== undefined &&
      isTnefMimeAlias(mimeType)) ||
    isTnefFileName(fileName)
  ) {
    return TNEF_MIME_TYPE;
  }
  const dotIndex = fileName?.lastIndexOf(".") ?? -1;
  if (!fileName || dotIndex === -1) {
    return null;
  }
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  return EMAIL_EXTENSION_MIME_TYPES[extension] ?? null;
};
