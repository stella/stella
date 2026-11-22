export const E_INVOICE_WORKER_MODE = {
  preview: "e-invoice-preview",
  attachment: "e-invoice-attachment",
} as const;

export const E_INVOICE_WORKER_EXIT = {
  unreadable: 20,
  rejected: 21,
  notInvoice: 22,
  noAttachment: 23,
} as const;

/** The attachment reply: one JSON header line, then the attachment's bytes. */
export const E_INVOICE_ATTACHMENT_HEADER_END = 0x0a;
