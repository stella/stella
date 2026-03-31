import { ClientUnknownError } from "@/lib/errors";

export const transformUnknownError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }

  if (error === undefined || error === null) {
    return new ClientUnknownError({
      message: "Unknown error (null or undefined)",
    });
  }

  if (typeof error === "object") {
    return new ClientUnknownError({
      message: JSON.stringify(error),
    });
  }

  return new ClientUnknownError({
    message: typeof error === "string" ? error : JSON.stringify(error),
  });
};

export const logDevError = (error: unknown) => {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error(error);
  }
};
