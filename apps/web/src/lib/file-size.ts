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
