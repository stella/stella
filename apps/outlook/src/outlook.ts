import { Result } from "better-result";

import { env } from "@/env";
import {
  attachmentCapabilityError,
  fromOfficeAsync,
  getCurrentOfficeItem,
  getOfficeAttachmentCapabilities,
  getOfficeRuntime,
  isOfficeAsyncValue,
  subscribeMailboxItemChanges as subscribeOfficeMailboxItemChanges,
  waitForOffice as waitForOfficeRuntime,
} from "@/lib/office";
import type { OfficeAsyncCallback, OfficeItem } from "@/lib/office";
import { OutlookError } from "@/lib/outlook-error";
import {
  ensureOutlookSourceId,
  isOutlookSourceId,
} from "@/lib/outlook-source-id";
import type {
  AttachmentDownloadResult,
  MailAddress,
  MailSnapshot,
  OutlookAttachment,
} from "@/types";

const readMaybeAsync = async <T>(
  value:
    | T
    | { getAsync: (callback: OfficeAsyncCallback<T>) => void }
    | undefined,
  fallback: T,
): Promise<T> => {
  if (value === undefined) {
    return fallback;
  }

  if (isOfficeAsyncValue<T>(value)) {
    return await fromOfficeAsync((callback) => value.getAsync(callback));
  }

  return value;
};

const normalizeAddress = (
  address: Office.EmailAddressDetails | undefined,
): MailAddress | null => {
  if (!address?.emailAddress) {
    return null;
  }

  return {
    email: address.emailAddress,
    name: address.displayName,
  };
};

const normalizeAddresses = (
  addresses: Office.EmailAddressDetails[],
): MailAddress[] => {
  const normalized: MailAddress[] = [];
  for (const address of addresses) {
    const item = normalizeAddress(address);
    if (item) {
      normalized.push(item);
    }
  }
  return normalized;
};

const readAddressList = async (
  value: Office.EmailAddressDetails[] | Office.MessageCompose["to"] | undefined,
): Promise<MailAddress[]> =>
  normalizeAddresses(
    await readMaybeAsync<Office.EmailAddressDetails[]>(value, []),
  );

const readBody = async (
  item: OfficeItem,
): Promise<{ bodyHtml: string; bodyText: string }> => {
  if (!item.body) {
    return { bodyHtml: "", bodyText: "" };
  }
  const body = item.body;

  const [bodyText, bodyHtml] = await Promise.all([
    fromOfficeAsync<string>((callback) => body.getAsync("text", callback)),
    fromOfficeAsync<string>((callback) => body.getAsync("html", callback)),
  ]);

  return {
    bodyHtml,
    bodyText,
  };
};

const normalizeAttachment = (attachment: {
  contentType?: string;
  id: string;
  isInline: boolean;
  name: string;
  size?: number;
}): OutlookAttachment => ({
  contentType: attachment.contentType ?? null,
  id: attachment.id,
  isInline: attachment.isInline,
  name: attachment.name,
  size: attachment.size ?? null,
});

const readAttachments = async (
  item: OfficeItem,
): Promise<OutlookAttachment[]> => {
  const capability = getOfficeAttachmentCapabilities(item).list;
  if (capability.status === "unavailable") {
    throw attachmentCapabilityError(capability);
  }

  try {
    return (await capability.read()).map(normalizeAttachment);
  } catch (error) {
    throw new OutlookError({
      cause: error,
      code: "attachment-read-unavailable",
      message: "Outlook could not read the message attachments.",
    });
  }
};

const getMode = (item: OfficeItem): MailSnapshot["mode"] => {
  if (isOfficeAsyncValue(item.subject)) {
    return "compose";
  }
  return "read";
};

const OUTLOOK_SOURCE_PROPERTY = "stellaEmailSourceId";

const runSourceIdentityOperation = async <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  const result = await Result.tryPromise(operation);
  if (Result.isError(result)) {
    throw new OutlookError({
      cause: result.error,
      code: "source-identity-unavailable",
      message: "Outlook source identity persistence failed.",
    });
  }
  return result.value;
};

const loadOutlookSourceId = async (
  item: OfficeItem,
  mode: MailSnapshot["mode"],
  persistence: "ensure" | "read",
): Promise<string | null> => {
  if (!item.loadCustomPropertiesAsync) {
    if (persistence === "read") {
      return null;
    }
    throw new OutlookError({
      code: "source-identity-unavailable",
      message: "Outlook cannot persist this message's filing identity.",
    });
  }
  const properties = await runSourceIdentityOperation(
    async () =>
      await fromOfficeAsync<Office.CustomProperties>((callback) =>
        item.loadCustomPropertiesAsync?.(callback),
      ),
  );
  const existing: unknown = properties.get(OUTLOOK_SOURCE_PROPERTY);
  if (isOutlookSourceId(existing)) {
    return existing;
  }
  if (persistence === "read") {
    return null;
  }
  return await ensureOutlookSourceId({
    existing,
    mode,
    persistProperty: async (sourceId) => {
      properties.set(OUTLOOK_SOURCE_PROPERTY, sourceId);
      await runSourceIdentityOperation(
        async () =>
          await fromOfficeAsync((callback) => properties.saveAsync(callback)),
      );
    },
    persistItem: async () => {
      if (!item.saveAsync) {
        throw new OutlookError({
          code: "source-identity-unavailable",
          message: "Outlook cannot save this draft's filing identity.",
        });
      }
      await runSourceIdentityOperation(
        async () =>
          await fromOfficeAsync<string>((callback) =>
            item.saveAsync?.(callback),
          ),
      );
    },
  });
};

const toIsoString = (value: Date | undefined): string | null => {
  if (!value) {
    return null;
  }
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
};

export const waitForOffice = async (): Promise<void> => {
  await waitForOfficeRuntime();
};

export const subscribeMailboxItemChanges = (
  subscriber: () => void,
): (() => void) => subscribeOfficeMailboxItemChanges(subscriber);

export const loadMailSnapshot = async (
  itemInstanceKey: string,
  sourceIdentityPersistence: "ensure" | "read" = "read",
): Promise<MailSnapshot> => {
  const office = getOfficeRuntime();
  if (!office) {
    if (env.buildEnvironment === "dev") {
      return createBrowserSampleSnapshot(itemInstanceKey);
    }
    throw new OutlookError({
      message:
        "The Outlook runtime is unavailable. Reopen the stella add-in from Outlook.",
    });
  }

  const item = getCurrentOfficeItem();
  if (!item) {
    throw new OutlookError({
      message: "No Outlook message is selected.",
    });
  }

  const mode = getMode(item);
  const sourceId = await loadOutlookSourceId(
    item,
    mode,
    sourceIdentityPersistence,
  );

  const subject = await readMaybeAsync(
    item.subject,
    item.normalizedSubject ?? "",
  );
  const from = normalizeAddress(
    await readMaybeAsync<Office.EmailAddressDetails | undefined>(
      item.from,
      undefined,
    ),
  );
  const [to, cc, bcc, body, attachments] = await Promise.all([
    readAddressList(item.to),
    readAddressList(item.cc),
    readAddressList(item.bcc),
    readBody(item),
    readAttachments(item),
  ]);

  return {
    attachments,
    bcc,
    bodyHtml: body.bodyHtml,
    bodyText: body.bodyText,
    cc,
    conversationId: item.conversationId ?? null,
    from,
    internetMessageId: item.internetMessageId ?? null,
    itemInstanceKey,
    itemId: item.itemId ?? null,
    mode,
    sentAt: toIsoString(item.dateTimeCreated ?? item.dateTimeModified),
    sourceId,
    subject: subject.trim() || "(No subject)",
    to,
    userEmail: office.context.mailbox.userProfile.emailAddress,
  };
};

const base64ToFile = ({
  base64,
  contentType,
  name,
}: {
  base64: string;
  contentType: string;
  name: string;
}): File => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return new File([bytes], name, { type: contentType });
};

export const downloadAttachment = async (
  attachment: OutlookAttachment,
): Promise<AttachmentDownloadResult> => {
  if (attachment.isInline) {
    return {
      attachmentId: attachment.id,
      reason: `${attachment.name}: inline attachment skipped`,
      type: "skipped",
    };
  }

  const item = getCurrentOfficeItem();
  if (!item) {
    throw new OutlookError({
      code: "attachment-read-unavailable",
      message: "No Outlook message is selected for attachment download.",
    });
  }

  const capability = getOfficeAttachmentCapabilities(item).content;
  if (capability.status === "unavailable") {
    throw attachmentCapabilityError(capability);
  }

  let content: { content: string; format: string };
  try {
    content = await capability.read(attachment.id);
  } catch (error) {
    throw new OutlookError({
      cause: error,
      code: "attachment-read-unavailable",
      message: `${attachment.name}: Outlook could not read this attachment.`,
    });
  }

  if (content.format !== "base64") {
    throw new OutlookError({
      code: "attachment-read-unavailable",
      message: `${attachment.name}: Outlook returned an unsupported attachment format.`,
    });
  }

  return {
    attachmentId: attachment.id,
    file: base64ToFile({
      base64: content.content,
      contentType: attachment.contentType ?? "application/octet-stream",
      name: attachment.name,
    }),
    type: "downloaded",
  };
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const textToHtml = (value: string): string =>
  value
    .split("\n")
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("");

export type DraftPlacement = "clipboard" | "composeBody" | "replyForm";

export const placeDraft = async (draft: string): Promise<DraftPlacement> => {
  const item = getCurrentOfficeItem();
  if (!item) {
    await navigator.clipboard.writeText(draft);
    return "clipboard";
  }

  if (item.body && getMode(item) === "compose") {
    const body = item.body;
    await fromOfficeAsync((callback) =>
      body.prependAsync(draft, { coercionType: "text" }, callback),
    );
    return "composeBody";
  }

  if (item.displayReplyForm) {
    item.displayReplyForm({ htmlBody: textToHtml(draft) });
    return "replyForm";
  }

  await navigator.clipboard.writeText(draft);
  return "clipboard";
};

const createBrowserSampleSnapshot = (
  itemInstanceKey: string,
): MailSnapshot => ({
  attachments: [
    {
      contentType: "application/pdf",
      id: "sample-attachment",
      isInline: false,
      name: "draft-share-purchase-agreement.pdf",
      size: 348_200,
    },
  ],
  bcc: [],
  bodyHtml:
    "<p>Hi team,</p><p>Please review the attached draft before Friday.</p>",
  bodyText:
    "Hi team,\n\nPlease review the attached draft SPA before Friday. Are we comfortable with the warranty cap and the disclosure schedule language?\n\nBest,\nClient",
  cc: [],
  conversationId: "sample-conversation",
  from: { email: "client@example.com", name: "Client" },
  internetMessageId: "<sample-message@example.com>",
  itemInstanceKey,
  itemId: "sample-item",
  mode: "browser",
  sentAt: new Date().toISOString(),
  sourceId: "00000000-0000-7000-8000-000000000001",
  subject: "SPA review before Friday",
  to: [{ email: "lawyer@stella.local", name: "Lawyer" }],
  userEmail: "lawyer@stella.local",
});
