import type { SafeId } from "@stll/api/types";

export type MailAddress = {
  email: string;
  name: string;
};

export type OutlookAttachment = {
  contentType: string | null;
  id: string;
  isInline: boolean;
  name: string;
  size: number | null;
};

export type MailSnapshot = {
  attachments: OutlookAttachment[];
  bcc: MailAddress[];
  bodyText: string;
  cc: MailAddress[];
  conversationId: string | null;
  from: MailAddress | null;
  internetMessageId: string | null;
  itemInstanceKey: string;
  itemId: string | null;
  mode: "browser" | "compose" | "read";
  sentAt: string | null;
  subject: string;
  to: MailAddress[];
  userEmail: string | null;
};

export type AttachmentDownloadResult =
  | {
      attachmentId: string;
      file: File;
      type: "downloaded";
    }
  | {
      attachmentId: string;
      reason: string;
      type: "skipped";
    };

export type WorkspaceSummary = {
  clientName: string | null;
  id: SafeId<"workspace">;
  lastActivityAt: Date | string | null;
  name: string;
  reference: string | null;
};

export type DraftCheck = {
  description: string;
  title: string;
  type: "info" | "risk" | "warning";
};
