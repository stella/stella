export const parseEmailDate = (value: string | null): Date | null => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export type EmailAttachmentSize = {
  unit: "byte" | "gigabyte" | "kilobyte" | "megabyte";
  value: number;
};

export const getEmailAttachmentSize = (
  sizeBytes: number,
): EmailAttachmentSize => {
  if (sizeBytes < 1000) {
    return { unit: "byte", value: sizeBytes };
  }

  if (sizeBytes < 1000 * 1000) {
    return { unit: "kilobyte", value: sizeBytes / 1000 };
  }

  if (sizeBytes < 1000 * 1000 * 1000) {
    return { unit: "megabyte", value: sizeBytes / (1000 * 1000) };
  }

  return { unit: "gigabyte", value: sizeBytes / (1000 * 1000 * 1000) };
};
