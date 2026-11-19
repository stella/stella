import { env } from "@/env";

export const socialProviderFlags = {
  google: env.VITE_AUTH_GOOGLE,
  microsoft: env.VITE_AUTH_MICROSOFT,
  apple: env.VITE_AUTH_APPLE,
};
