import { Result } from "better-result";
import { parseArgs } from "node:util";
import * as v from "valibot";

import {
  ServiceClientOperatorError,
  createServiceOAuthClient,
  changeServiceOAuthClient,
} from "@/api/lib/auth/service-client-operator";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    "organization-id": { type: "string" },
    name: { type: "string" },
    "client-id": { type: "string" },
    "requests-per-minute": { type: "string" },
    "daily-budget": { type: "string" },
  },
});
const operation = v.parse(
  v.picklist(["create", "rotate", "disable"]),
  positionals.at(0),
);
if (
  (operation === "create" || operation === "rotate") &&
  !process.stdout.isTTY
) {
  throw new ServiceClientOperatorError({
    message:
      "Run in an interactive terminal: the client secret is displayed once.",
  });
}
const operatorUid = process.getuid?.();
if (operatorUid === undefined) {
  throw new ServiceClientOperatorError({
    message: "An operating-system operator identity is required.",
  });
}
const positiveLimit = (maximum: number) =>
  v.pipe(
    v.string(),
    v.regex(/^[1-9][0-9]*$/u),
    v.transform(Number),
    v.maxValue(maximum),
  );
const result = await Result.tryPromise(async () => {
  if (operation === "create") {
    return await createServiceOAuthClient({
      organizationId: v.parse(
        v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        values["organization-id"],
      ),
      name: v.parse(
        v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        values.name,
      ),
      requestsPerMinute: v.parse(
        positiveLimit(600),
        values["requests-per-minute"],
      ),
      dailyBudget: v.parse(positiveLimit(100_000), values["daily-budget"]),
      operatorUid,
    });
  }
  return await changeServiceOAuthClient({
    clientId: v.parse(
      v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      values["client-id"],
    ),
    operation,
    operatorUid,
  });
});
if (Result.isError(result)) {
  // Do not print database errors: their parameters may contain credential material.
  process.stderr.write(
    "Service client operation failed; no credentials were displayed.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(result.value)}\n`);
}
