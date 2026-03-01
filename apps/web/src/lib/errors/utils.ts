export const transformUnknownError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }

  if (!error) {
    return;
  }

  if (typeof error === "object") {
    return new Error(JSON.stringify(error));
  }

  return new Error(String(error));
};
