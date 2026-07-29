import { parseMobileApiUrl } from "@/config/api-url";

const isDevelopmentBuild =
  typeof __DEV__ === "boolean"
    ? __DEV__
    : process.env.NODE_ENV !== "production";

export const env = {
  API_URL: parseMobileApiUrl(process.env.EXPO_PUBLIC_API_URL, {
    allowAndroidEmulatorHttp: isDevelopmentBuild,
  }),
  RUNTIME: process.env.EXPO_OS === "web" ? "web" : "native",
} as const;
