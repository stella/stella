import { createDevErrorLogger } from "@stll/errors";

import { ClientUnknownError } from "@/lib/errors/client";

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

export const logDevError = createDevErrorLogger({
  isDev: import.meta.env.DEV,
});
