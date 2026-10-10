import { Result } from "better-result";
import { parseArgs } from "node:util";
import * as v from "valibot";

import {
  createServiceOAuthClient,
  changeServiceOAuthClient,
} from "@/api/db/root";
import { ServiceClientOperatorError } from "@/api/lib/auth/service-client-operator";
import { SERVICE_CLIENT_BUDGET_CEILINGS } from "@/api/lib/auth/service-client-policy";
import { getMcpResourceUrl } from "@/api/mcp/constants";

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
if (positionals.length !== 1) {
  throw new ServiceClientOperatorError({
    message: "Specify exactly one operation.",
  });
}
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
    const input = v.parse(
      v.strictObject({
        "organization-id": v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        "requests-per-minute": positiveLimit(
          SERVICE_CLIENT_BUDGET_CEILINGS.requestsPerMinute,
        ),
        "daily-budget": positiveLimit(
          SERVICE_CLIENT_BUDGET_CEILINGS.dailyBudget,
        ),
      }),
      values,
    );
    return await createServiceOAuthClient({
      organizationId: input["organization-id"],
      lawResourceUrl: getMcpResourceUrl("law"),
      name: input.name,
      requestsPerMinute: input["requests-per-minute"],
      dailyBudget: input["daily-budget"],
      operatorUid,
    });
  }
  const input = v.parse(
    v.strictObject({
      "client-id": v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
    values,
  );
  return await changeServiceOAuthClient({
    clientId: input["client-id"],
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
