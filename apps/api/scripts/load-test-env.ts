import { TaggedError } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

class InvalidTestEnvironmentError extends TaggedError(
  "InvalidTestEnvironmentError",
)<{
  message: string;
}> {}

const TEST_ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL"] as const;

/** The generated test configuration takes precedence over Bun's automatic .env. */
export const loadTestEnv = (filePath: string) => {
  if (!existsSync(filePath)) {
    return;
  }
  const source = readFileSync(filePath, "utf-8");
  const values = parseEnv(source);
  if (
    values["NODE_ENV"] !== "test" ||
    TEST_ENV_KEYS.some((key) => !values[key])
  ) {
    throw new InvalidTestEnvironmentError({
      message:
        ".env.test must define NODE_ENV=test and nonempty DATABASE_URL and REDIS_URL.",
    });
  }
  for (const key of TEST_ENV_KEYS) {
    process.env[key] = values[key];
  }
};
