import { Result } from "better-result";
import * as v from "valibot";

import { moneySchema } from "@stll/api-contract/billing-money";

import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { cents } from "@/api/lib/money";

const config = {
  contract: "patch",
  access: "read",
  description: "Money schema type fixture.",
  permissions: { billing: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "billing_admin",
    consumesServices: false,
    readClass: "tenant",
  },
} as const satisfies HandlerConfig;
createSafeRootHandler(
  config,
  // @ts-expect-error Monetary handler results require a declared response schema.
  async function* () {
    yield* Result.await(Promise.resolve(Result.ok(null)));
    return Result.ok({ arbitrary: [{ renamed: cents(123) }] });
  },
);
createSafeRootHandler(
  {
    ...config,
    moneyResponse: v.object({
      arbitrary: v.array(v.object({ renamed: moneySchema })),
    }),
  },
  async function* () {
    yield* Result.await(Promise.resolve(Result.ok(null)));
    return Result.ok({ arbitrary: [{ renamed: cents(123) }] });
  },
);

createSafeRootHandler(
  { ...config, moneyResponse: v.object({ unrelated: v.number() }) },
  // @ts-expect-error A response projection must classify every returned monetary field.
  async function* () {
    yield* Result.await(Promise.resolve(Result.ok(null)));
    return Result.ok({ arbitrary: [{ renamed: cents(123) }] });
  },
);
