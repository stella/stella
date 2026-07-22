import { parseMobileApiUrl } from "@/config/api-url";

export const env = {
  API_URL: parseMobileApiUrl(process.env.EXPO_PUBLIC_API_URL),
  RUNTIME: process.env.EXPO_OS === "web" ? "web" : "native",
} as const;
