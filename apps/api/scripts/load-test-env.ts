import { TaggedError } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

class InvalidTestEnvironmentError extends TaggedError(
  "InvalidTestEnvironmentError",
)<{
  message: string;
}> {}

/** The generated test configuration takes precedence over Bun's automatic .env. */
export const loadTestEnv = (filePath: string) => {
  if (!existsSync(filePath)) {
    return;
  }
  const source = readFileSync(filePath, "utf-8");
  const values = parseEnv(source);
  const nodeEnv = values["NODE_ENV"];
  const databaseUrl = values["DATABASE_URL"];
  const redisUrl = values["REDIS_URL"];
  if (nodeEnv !== "test" || !databaseUrl || !redisUrl) {
    throw new InvalidTestEnvironmentError({
      message:
        ".env.test must define NODE_ENV=test and nonempty DATABASE_URL and REDIS_URL.",
    });
  }
  for (const [key, value] of Object.entries({
    NODE_ENV: nodeEnv,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
  })) {
    process.env[key] = value;
  }
};
