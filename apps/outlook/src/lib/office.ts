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

export const isOfficeDialogApi = (value: unknown): value is Office.UI =>
  isRecord(value) && typeof value["displayDialogAsync"] === "function";

export const getOfficeDialogApi = (): Office.UI | null => {
  const office = getOfficeRuntime();
  if (!office) {
    return null;
  }

  const value: unknown = office.context.ui;
  return isOfficeDialogApi(value) ? value : null;
};

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

type SupportsOfficeRequirementOptions = {
  name: string;
  requirements: unknown;
  version: string;
};

export const supportsOfficeRequirement = ({
  name,
  requirements,
  version,
}: SupportsOfficeRequirementOptions): boolean => {
  if (!isRecord(requirements)) {
    return false;
  }
  const isSetSupported = requirements["isSetSupported"];
  if (typeof isSetSupported !== "function") {
    return false;
  }
  try {
    return isSetSupported.call(requirements, name, version) === true;
  } catch {
    return false;
  }
};

const supportsMailbox18 = (office: OfficeRuntime): boolean =>
  supportsOfficeRequirement({
    name: "Mailbox",
    requirements: office.context.requirements,
    version: "1.8",
  });

type OfficeAttachmentDetails =
  | Pick<
      Office.AttachmentDetails,
      "contentType" | "id" | "isInline" | "name" | "size"
    >
  | Pick<Office.AttachmentDetailsCompose, "id" | "isInline" | "name" | "size">;

export const toOfficeAttachmentMetadata = (
  attachment: OfficeAttachmentDetails,
): OfficeAttachmentMetadata => {
  const metadata = {
    id: attachment.id,
    isInline: attachment.isInline,
    name: attachment.name,
    size: attachment.size,
  };
  if (!("contentType" in attachment)) {
    return metadata;
  }

  const contentType: unknown = Reflect.get(attachment, "contentType");
  return typeof contentType === "string"
    ? { ...metadata, contentType }
    : metadata;
};

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
      read: async () =>
        await Promise.resolve(attachmentList.map(toOfficeAttachmentMetadata)),
      status: "available",
    };
  } else if (mailbox18 && typeof getAttachmentsAsync === "function") {
    list = {
      read: async () =>
        (
          await fromOfficeAsync<Office.AttachmentDetailsCompose[]>((callback) =>
            getAttachmentsAsync.call(item, callback),
          )
        ).map(toOfficeAttachmentMetadata),
      status: "available",
    };
  } else {
    list = unavailable(
      mailbox18 ? "api-unavailable" : "requirement-unsupported",
    );
  }

  const getAttachmentContentAsync = item.getAttachmentContentAsync;
  let content: OfficeAttachmentContentCapability;
  if (mailbox18 && typeof getAttachmentContentAsync === "function") {
    content = {
      read: async (attachmentId) =>
        await fromOfficeAsync<Office.AttachmentContent>((callback) =>
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

export const attachmentCapabilityError = (capability: {
  reason: "api-unavailable" | "requirement-unsupported";
  status: "unavailable";
}): OutlookError =>
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
