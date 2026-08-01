export const containsNull = (value: unknown): boolean => {
  if (value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsNull);
  }
  if (typeof value === "object") {
    return Object.values(value).some(containsNull);
  }
  return false;
};
