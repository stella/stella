import type { StellaEdenClientOptions } from "@stll/api-client";

type AuthTransportRuntime = "native" | "web";
type ReadAuthCookie = () => string | null | undefined;

export const createAuthTransportOptions = (
  runtime: AuthTransportRuntime,
  readAuthCookie: ReadAuthCookie,
) => {
  if (runtime === "web") {
    return {
      fetch: { credentials: "include" },
      headers: () => ({}),
    } as const satisfies StellaEdenClientOptions;
  }

  return {
    fetch: { credentials: "omit" },
    headers: () => {
      const cookie = readAuthCookie();
      if (!cookie) {
        return {};
      }
      return { Cookie: cookie };
    },
  } as const satisfies StellaEdenClientOptions;
};
