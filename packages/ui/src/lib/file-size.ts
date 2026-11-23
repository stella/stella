export const getFileSizeDisplay = (sizeBytes: number) => {
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

/** Formats a number in the reader's locale, as `use-intl`'s formatter does. */
type NumberFormatter = {
  readonly number: (
    value: number,
    options: {
      maximumFractionDigits: number;
      style: "unit";
      unit: string;
      unitDisplay: "long" | "short";
    },
  ) => string;
};

/**
 * A file size in the reader's locale, at most one decimal ("1.2 MB"). Bytes
 * use the long, plural-aware unit ("333 bytes", "333 bajtů"): the short
 * English unit has no plural ("333 byte").
 */
export const formatFileSize = (
  sizeBytes: number,
  format: NumberFormatter,
): string => {
  const size = getFileSizeDisplay(sizeBytes);
  return format.number(size.value, {
    maximumFractionDigits: 1,
    style: "unit",
    unit: size.unit,
    unitDisplay: size.unit === "byte" ? "long" : "short",
  });
};
