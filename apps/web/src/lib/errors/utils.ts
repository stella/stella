export const transformUnknownError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }

  if (error === undefined || error === null) {
    return;
  }

  if (typeof error === "object") {
    return new Error(JSON.stringify(error));
  }

  // oxlint-disable-next-line typescript/no-base-to-string
  return new Error(String(error));
};
