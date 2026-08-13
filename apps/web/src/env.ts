import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import {
  browserApiInvariantViolation,
  envWebClientSchema,
  envWebInvariantViolation,
} from "@/env-schema";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: envWebClientSchema,
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
});

const invariantViolation = envWebInvariantViolation(env);
if (invariantViolation !== null) {
  panic(invariantViolation);
}

const browserApiViolation = browserApiInvariantViolation({
  browserApiUrl: env.VITE_BROWSER_API_URL,
  publicAppUrl: env.VITE_PUBLIC_APP_URL,
});
if (browserApiViolation !== null) {
  panic(browserApiViolation);
}
