import type {
  AttachmentDownloadResult,
  MailAddress,
  MailSnapshot,
  OutlookAttachment,
} from "@/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAsyncValue = <T>(value: unknown): value is Office.AsyncValue<T> =>
  isRecord(value) && typeof value["getAsync"] === "function";

const isOfficeRuntime = (value: unknown): value is typeof Office =>
  isRecord(value) &&
  typeof value["onReady"] === "function" &&
  isRecord(value["context"]);

const getOffice = (): typeof Office | null => {
  const value: unknown = Reflect.get(globalThis, "Office");
  return isOfficeRuntime(value) ? value : null;
};

const fromAsync = async <T>(
  invoke: (callback: Office.AsyncCallback<T>) => void,
): Promise<T> =>
  await new Promise((resolve, reject) => {
    invoke((result) => {
      if (result.status === "succeeded") {
        resolve(result.value);
        return;
      }

      reject(new Error(result.error?.message ?? "Office request failed"));
    });
  });

const readMaybeAsync = async <T>(
  value: Office.AsyncValue<T> | T | undefined,
  fallback: T,
): Promise<T> => {
  if (value === undefined) {
    return fallback;
  }

  if (isAsyncValue<T>(value)) {
    return await fromAsync((callback) => value.getAsync(callback));
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
    name: address.displayName ?? "",
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
  value:
    | Office.AsyncValue<Office.EmailAddressDetails[]>
    | Office.EmailAddressDetails[]
    | undefined,
): Promise<MailAddress[]> =>
  normalizeAddresses(await readMaybeAsync(value, []));

const readBodyText = async (item: Office.MailboxItem): Promise<string> => {
  if (!item.body) {
    return "";
  }
  const body = item.body;

  return await fromAsync((callback) => body.getAsync("text", callback));
};

const normalizeAttachment = (
  attachment: Office.AttachmentDetails,
): OutlookAttachment => ({
  contentType: attachment.contentType ?? null,
  id: attachment.id,
  isInline: attachment.isInline ?? false,
  name: attachment.name,
  size: attachment.size ?? null,
});

const readAttachments = async (
  item: Office.MailboxItem,
): Promise<OutlookAttachment[]> => {
  if (Array.isArray(item.attachments)) {
    return item.attachments.map(normalizeAttachment);
  }

  const getAttachmentsAsync = item.getAttachmentsAsync;
  if (!getAttachmentsAsync) {
    return [];
  }

  const attachments = await fromAsync<Office.AttachmentDetails[]>((callback) =>
    getAttachmentsAsync.call(item, callback),
  );

  return attachments.map(normalizeAttachment);
};

const getCurrentItem = (): Office.MailboxItem | null => {
  const office = getOffice();
  if (!office) {
    return null;
  }
  return office.context.mailbox.item ?? null;
};

const getMode = (item: Office.MailboxItem): MailSnapshot["mode"] => {
  if (isAsyncValue<string>(item.subject)) {
    return "compose";
  }
  return "read";
};

const toIsoString = (value: Date | undefined): string | null => {
  if (!value) {
    return null;
  }
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
};

export const waitForOffice = async (): Promise<void> => {
  const office = getOffice();
  if (!office) {
    return;
  }
  await office.onReady();
};

export const loadMailSnapshot = async (): Promise<MailSnapshot> => {
  const item = getCurrentItem();
  if (!item) {
    return createBrowserSampleSnapshot();
  }

  const subject = await readMaybeAsync(
    item.subject,
    item.normalizedSubject ?? "",
  );
  const from = normalizeAddress(await readMaybeAsync(item.from, undefined));
  const [to, cc, bodyText, attachments] = await Promise.all([
    readAddressList(item.to),
    readAddressList(item.cc),
    readBodyText(item),
    readAttachments(item),
  ]);

  return {
    attachments,
    bodyText,
    cc,
    conversationId: item.conversationId ?? null,
    from,
    internetMessageId: item.internetMessageId ?? null,
    itemId: item.itemId ?? null,
    mode: getMode(item),
    sentAt: toIsoString(item.dateTimeCreated ?? item.dateTimeModified),
    subject: subject.trim() || "(No subject)",
    to,
    userEmail: getOffice()?.context.mailbox.userProfile?.emailAddress ?? null,
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

  const item = getCurrentItem();
  const getAttachmentContentAsync = item?.getAttachmentContentAsync;
  if (!item || !getAttachmentContentAsync) {
    return {
      attachmentId: attachment.id,
      reason: `${attachment.name}: attachment download is not supported by this Outlook host`,
      type: "skipped",
    };
  }

  const content = await fromAsync<Office.AttachmentContent>((callback) =>
    getAttachmentContentAsync.call(item, attachment.id, callback),
  );

  if (content.format !== "base64") {
    return {
      attachmentId: attachment.id,
      reason: `${attachment.name}: ${content.format} attachments are not uploaded in V1`,
      type: "skipped",
    };
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
  const item = getCurrentItem();
  if (!item) {
    await navigator.clipboard.writeText(draft);
    return "clipboard";
  }

  if (item.body && getMode(item) === "compose") {
    const body = item.body;
    await fromAsync<undefined>((callback) =>
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

const createBrowserSampleSnapshot = (): MailSnapshot => ({
  attachments: [
    {
      contentType: "application/pdf",
      id: "sample-attachment",
      isInline: false,
      name: "draft-share-purchase-agreement.pdf",
      size: 348_200,
    },
  ],
  bodyText:
    "Hi team,\n\nPlease review the attached draft SPA before Friday. Are we comfortable with the warranty cap and the disclosure schedule language?\n\nBest,\nClient",
  cc: [],
  conversationId: "sample-conversation",
  from: { email: "client@example.com", name: "Client" },
  internetMessageId: "<sample-message@example.com>",
  itemId: "sample-item",
  mode: "browser",
  sentAt: new Date().toISOString(),
  subject: "SPA review before Friday",
  to: [{ email: "lawyer@stella.local", name: "Lawyer" }],
  userEmail: "lawyer@stella.local",
});
