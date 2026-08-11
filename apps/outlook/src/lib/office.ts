import { OutlookError } from "@/lib/outlook-error";

export type OfficeRuntime = typeof Office;
export type OfficeItem = Partial<NonNullable<Office.Mailbox["item"]>>;
export type OfficeAsyncCallback<T> = (result: Office.AsyncResult<T>) => void;

export type OfficeAttachmentMetadata = {
  contentType?: string;
  id: string;
  isInline: boolean;
  name: string;
  size?: number;
};

export type OfficeAttachmentListCapability =
  | {
      read: () => Promise<OfficeAttachmentMetadata[]>;
      status: "available";
    }
  | {
      reason: "api-unavailable" | "requirement-unsupported";
      status: "unavailable";
    };

export type OfficeAttachmentContent = {
  content: string;
  format: string;
};

export type OfficeAttachmentContentCapability =
  | {
      read: (attachmentId: string) => Promise<OfficeAttachmentContent>;
      status: "available";
    }
  | {
      reason: "api-unavailable" | "requirement-unsupported";
      status: "unavailable";
    };

export type OfficeAttachmentCapabilities = {
  content: OfficeAttachmentContentCapability;
  list: OfficeAttachmentListCapability;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOfficeRuntime = (value: unknown): value is OfficeRuntime =>
  isRecord(value) &&
  typeof value["onReady"] === "function" &&
  isRecord(value["context"]);

let officeRuntimeOverride: OfficeRuntime | null | undefined;

/** Allows unit tests to exercise the adapter without mutating the global object. */
export const setOfficeRuntimeForTesting = (runtime: OfficeRuntime | null) => {
  officeRuntimeOverride = runtime;
};

export const resetOfficeRuntimeForTesting = () => {
  officeRuntimeOverride = undefined;
};

export const getOfficeRuntime = (): OfficeRuntime | null => {
  if (officeRuntimeOverride !== undefined) {
    return officeRuntimeOverride;
  }

  const value: unknown = Reflect.get(globalThis, "Office");
  return isOfficeRuntime(value) ? value : null;
};

export const getCurrentOfficeItem = (): OfficeItem | null =>
  getOfficeRuntime()?.context.mailbox.item ?? null;

export const getOfficeDisplayLanguage = (): string | undefined =>
  getOfficeRuntime()?.context.displayLanguage;

export const fromOfficeAsync = async <T>(
  invoke: (callback: OfficeAsyncCallback<T>) => void,
): Promise<T> => {
  const office = getOfficeRuntime();
  if (!office) {
    throw new OutlookError({
      message: "The Office runtime is unavailable.",
    });
  }

  return await new Promise((resolve, reject) => {
    invoke((result) => {
      if (result.status === office.AsyncResultStatus.Succeeded) {
        resolve(result.value);
        return;
      }

      reject(
        new OutlookError({
          message: result.error.message || "Office request failed.",
        }),
      );
    });
  });
};

export const isOfficeAsyncValue = <T>(
  value: unknown,
): value is { getAsync: (callback: OfficeAsyncCallback<T>) => void } =>
  isRecord(value) && typeof value["getAsync"] === "function";

const supportsMailbox18 = (office: OfficeRuntime): boolean => {
  const requirements = office.context.requirements;
  try {
    return requirements.isSetSupported("Mailbox", "1.8");
  } catch {
    return false;
  }
};

const attachmentMetadata = (
  attachment: Office.AttachmentDetails | Office.AttachmentDetailsCompose,
): OfficeAttachmentMetadata => ({
  id: attachment.id,
  isInline: attachment.isInline,
  name: attachment.name,
  size: attachment.size,
});

const unavailable = (
  reason: "api-unavailable" | "requirement-unsupported",
): { reason: typeof reason; status: "unavailable" } => ({
  reason,
  status: "unavailable",
});

export const getOfficeAttachmentCapabilities = (
  item: OfficeItem,
): OfficeAttachmentCapabilities => {
  const office = getOfficeRuntime();
  const mailbox18 = office ? supportsMailbox18(office) : false;
  const attachmentList = item.attachments;
  const getAttachmentsAsync = item.getAttachmentsAsync;

  let list: OfficeAttachmentListCapability;
  if (Array.isArray(attachmentList)) {
    list = {
      read: () => Promise.resolve(attachmentList.map(attachmentMetadata)),
      status: "available",
    };
  } else if (mailbox18 && typeof getAttachmentsAsync === "function") {
    list = {
      read: () =>
        fromOfficeAsync<Office.AttachmentDetailsCompose[]>((callback) =>
          getAttachmentsAsync.call(item, callback),
        ).then((attachments) => attachments.map(attachmentMetadata)),
      status: "available",
    };
  } else {
    list = unavailable(mailbox18 ? "api-unavailable" : "requirement-unsupported");
  }

  const getAttachmentContentAsync = item.getAttachmentContentAsync;
  let content: OfficeAttachmentContentCapability;
  if (mailbox18 && typeof getAttachmentContentAsync === "function") {
    content = {
      read: (attachmentId) =>
        fromOfficeAsync<Office.AttachmentContent>((callback) =>
          getAttachmentContentAsync.call(item, attachmentId, callback),
        ),
      status: "available",
    };
  } else {
    content = unavailable(
      mailbox18 ? "api-unavailable" : "requirement-unsupported",
    );
  }

  return { content, list };
};

export const attachmentCapabilityError = (
  capability: {
    reason: "api-unavailable" | "requirement-unsupported";
    status: "unavailable";
  },
): OutlookError =>
  new OutlookError({
    code: "attachment-read-unavailable",
    message:
      capability.reason === "requirement-unsupported"
        ? "This Outlook host does not support the required attachment API."
        : "The Outlook attachment API is unavailable in this session.",
  });

export const waitForOffice = async (): Promise<void> => {
  const office = getOfficeRuntime();
  if (!office) {
    return;
  }
  await office.onReady();
};

export const subscribeMailboxItemChanges = (
  subscriber: () => void,
): (() => void) => {
  const office = getOfficeRuntime();
  if (!office) {
    return () => undefined;
  }

  const mailbox = office.context.mailbox;
  const handler = () => subscriber();
  mailbox.addHandlerAsync(office.EventType.ItemChanged, handler);

  return () => {
    mailbox.removeHandlerAsync(office.EventType.ItemChanged);
  };
};
