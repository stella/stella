declare namespace Office {
  const AsyncResultStatus: {
    readonly Failed: "failed";
    readonly Succeeded: "succeeded";
  };

  const CoercionType: {
    readonly Html: "html";
    readonly Text: "text";
  };

  const EventType: {
    readonly ItemChanged: "itemChanged";
  };

  type AsyncResultStatusValue =
    (typeof AsyncResultStatus)[keyof typeof AsyncResultStatus];

  type AsyncError = {
    code?: number | string;
    message?: string;
    name?: string;
  };

  type AsyncResult<T> = {
    error?: AsyncError;
    status: AsyncResultStatusValue;
    value: T;
  };

  type AsyncCallback<T> = (result: AsyncResult<T>) => void;

  type AsyncValue<T> = {
    getAsync(callback: AsyncCallback<T>): void;
    getAsync(options: unknown, callback: AsyncCallback<T>): void;
  };

  type EmailAddressDetails = {
    appointmentResponse?: string;
    displayName?: string;
    emailAddress?: string;
    recipientType?: string;
  };

  type AttachmentDetails = {
    attachmentType?: string;
    contentType?: string;
    id: string;
    isInline?: boolean;
    name: string;
    size?: number;
  };

  type AttachmentContent = {
    content: string;
    format: "base64" | "eml" | "iCalendar" | "url";
  };

  type Body = {
    getAsync(coercionType: string, callback: AsyncCallback<string>): void;
    getAsync(
      coercionType: string,
      options: unknown,
      callback: AsyncCallback<string>,
    ): void;
    prependAsync(
      data: string,
      options: unknown,
      callback: AsyncCallback<undefined>,
    ): void;
  };

  type MailboxItem = {
    attachments?: AttachmentDetails[];
    body?: Body;
    cc?: AsyncValue<EmailAddressDetails[]> | EmailAddressDetails[];
    conversationId?: string;
    dateTimeCreated?: Date;
    dateTimeModified?: Date;
    displayReplyForm?: (
      formData: { htmlBody?: string } | string,
      callback?: AsyncCallback<undefined>,
    ) => void;
    from?: AsyncValue<EmailAddressDetails> | EmailAddressDetails;
    getAttachmentContentAsync?: (
      attachmentId: string,
      callback: AsyncCallback<AttachmentContent>,
    ) => void;
    getAttachmentsAsync?: (
      callback: AsyncCallback<AttachmentDetails[]>,
    ) => void;
    internetMessageId?: string;
    itemId?: string;
    normalizedSubject?: string;
    subject?: AsyncValue<string> | string;
    to?: AsyncValue<EmailAddressDetails[]> | EmailAddressDetails[];
  };

  type Mailbox = {
    addHandlerAsync?: (
      eventType: (typeof EventType)[keyof typeof EventType],
      handler: (event: { type: string }) => void,
      callback?: AsyncCallback<undefined>,
    ) => void;
    item?: MailboxItem;
    removeHandlerAsync?: (
      eventType: (typeof EventType)[keyof typeof EventType],
      options: { handler: (event: { type: string }) => void },
      callback?: AsyncCallback<undefined>,
    ) => void;
    userProfile?: {
      displayName?: string;
      emailAddress?: string;
    };
  };

  type DialogMessageReceived = { message: string; origin?: string };
  type DialogEventReceived = { error?: number };
  type DialogHandlerType = "DialogMessageReceived" | "DialogEventReceived";
  type DialogHandler = (
    event: DialogMessageReceived | DialogEventReceived,
  ) => void;

  type Dialog = {
    addEventHandler(type: DialogHandlerType, handler: DialogHandler): void;
    close(): void;
  };

  type DisplayDialogOptions = {
    displayInIframe?: boolean;
    height?: number;
    promptBeforeOpen?: boolean;
    width?: number;
  };

  type DialogUi = {
    displayDialogAsync(
      startAddress: string,
      options: DisplayDialogOptions,
      callback: AsyncCallback<Dialog>,
    ): void;
    messageParent?: (
      message: string,
      options: { targetOrigin: string },
    ) => void;
  };

  const context: {
    diagnostics?: {
      host?: string;
      platform?: string;
    };
    mailbox: Mailbox;
    ui: DialogUi;
  };

  function onReady(callback?: () => void): Promise<void>;
}
