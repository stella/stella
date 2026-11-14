import { Result } from "better-result";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { readOperatorRegistrationPage } from "@/api/db/root";
import { env } from "@/api/env";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { parseRegistrationQuery } from "@/api/lib/db/operator-registrations/input";
import type { readAuditedRegistrationPage } from "@/api/lib/db/operator-registrations/read";

import { verifyOperatorCaller } from "./operator-caller";

export type OperatorRegistrationsOptions = {
  configuredToken: () => string | undefined;
  readPage: (
    query: Parameters<typeof readAuditedRegistrationPage>[1],
  ) => ReturnType<typeof readAuditedRegistrationPage>;
  now?: () => number;
};

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
  // Each value is read once; what it means (a window relative to now, a
  // cursor bound to it) is decided by `parseRegistrationQuery`.
  query: v.object({
    since: v.optional(v.pipe(v.string(), v.maxLength(64))),
    cursor: v.optional(paginationCursorSchema({ maxChars: 1024 })),
    limit: v.optional(v.pipe(v.string(), v.maxLength(16))),
  }),
} satisfies TokenHandlerConfig;

export const createOperatorRegistrations = ({
  configuredToken,
  readPage,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: OperatorRegistrationsOptions) =>
  createSafeTokenHandler(
    config,
    verifyOperatorCaller({
      refusedEvent: "operator.registrations.refused",
      configuredToken,
    }),
    async function* ({ query }) {
      const parsed = yield* parseRegistrationQuery({ query, now: now() });
      return Result.ok(await readPage(parsed));
    },
  );

const operatorRegistrations = createOperatorRegistrations({
  configuredToken: () => env.OPERATOR_API_TOKEN,
  readPage: readOperatorRegistrationPage,
});

export default operatorRegistrations;
