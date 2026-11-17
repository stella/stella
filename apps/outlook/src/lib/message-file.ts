import { mapWithConcurrency } from "@stll/concurrency";

import { buildEmlFile, emlFileName } from "@/lib/eml";
import { downloadAttachment, readCurrentMessageMime } from "@/outlook";
import type {
  AttachmentDownloadResult,
  MailSnapshot,
  OutlookAttachment,
} from "@/types";

const ATTACHMENT_DOWNLOAD_CONCURRENCY = 4;
const EMAIL_MIME_TYPE = "message/rfc822";

export type MessageFile = {
  readonly file: File;
  /** Attachments a rebuilt message could not include, by reason. */
  readonly skippedAttachments: readonly string[];
  /** `mailbox`: the stored MIME; `rebuilt`: composed from the item's fields. */
  readonly source: "mailbox" | "rebuilt";
};

type MessageFileDependencies = {
  readonly downloadAttachment: (
    attachment: OutlookAttachment,
  ) => Promise<AttachmentDownloadResult>;
  readonly readMime: () => Promise<Uint8Array<ArrayBuffer> | null>;
};

const defaultDependencies: MessageFileDependencies = {
  downloadAttachment,
  readMime: readCurrentMessageMime,
};

/** The selected message as one `.eml` file for filing. */
export const readMessageFile = async (
  snapshot: MailSnapshot,
  overrides: Partial<MessageFileDependencies> = {},
): Promise<MessageFile> => {
  const dependencies = { ...defaultDependencies, ...overrides };
  const name = emlFileName(snapshot.subject);
  const mime = await dependencies.readMime();
  if (mime !== null) {
    return {
      file: new File([mime], name, { type: EMAIL_MIME_TYPE }),
      skippedAttachments: [],
      source: "mailbox",
    };
  }
  const attachments = await mapWithConcurrency({
    items: snapshot.attachments,
    limit: ATTACHMENT_DOWNLOAD_CONCURRENCY,
    operation: dependencies.downloadAttachment,
  });
  return {
    file: await buildEmlFile({ attachments, snapshot }),
    skippedAttachments: attachments.flatMap((attachment) =>
      attachment.type === "skipped" ? [attachment.reason] : [],
    ),
    source: "rebuilt",
  };
};
