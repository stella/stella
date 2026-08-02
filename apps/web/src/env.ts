import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { envWebClientSchema, envWebInvariantViolation } from "@/env-schema";

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
