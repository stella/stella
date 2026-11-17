import { expect, test } from "bun:test";
import * as v from "valibot";

import { TIME_ENTRY_REPORT_QUERY_SCHEMA } from "@stll/api-contract/time-entry-report";

import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

import report from "./get";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();

test.each([
  { from: "2020-01-02", to: "2020-01-01" },
  { from: "2020-01-01", to: "2021-01-01" },
])(
  "rejects invalid or unbounded report range before database access: $from to $to",
  async (range) => {
    const response = await report.handler(
      createTestHandlerContext<Parameters<typeof report.handler>[0]>({
        session: { activeOrganizationId: organizationId },
        user: { id: userId },
        featureAccessSnapshot: enrolledTimeBillingSnapshot({
          organizationId,
          userId,
        }),
        audit: NO_AUDIT,
        safeDb: NO_DB,
        scopedDb: NO_DB,
        query: { ...range, groupBy: "member", bucket: "day" },
      }),
    );
    expect(response).toMatchObject({ code: 400 });
  },
);

test("the shared input schema rejects nonexistent calendar dates", () => {
  expect(
    v.safeParse(TIME_ENTRY_REPORT_QUERY_SCHEMA, {
      from: "2020-02-30",
      to: "2020-03-01",
      groupBy: "member",
      bucket: "day",
    }).success,
  ).toBe(false);
});
