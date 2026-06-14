export const INVOICE_ENTRIES_MODIFIED_MESSAGE =
  "Some entries were modified concurrently; please retry";

export class InvoiceEntriesModifiedConcurrentlyError extends Error {
  constructor() {
    super(INVOICE_ENTRIES_MODIFIED_MESSAGE);
    this.name = "InvoiceEntriesModifiedConcurrentlyError";
  }
}

export const isInvoiceEntriesModifiedConcurrentlyError = (
  error: unknown,
): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (current instanceof InvoiceEntriesModifiedConcurrentlyError) {
      return true;
    }
    if (!(current instanceof Error)) {
      return false;
    }
    current = current.cause;
  }
  return false;
};
