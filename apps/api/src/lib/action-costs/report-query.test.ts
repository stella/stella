import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { actionCostReportQuery } from "./report-query";

test("operator reports reject invalid and unbounded time ranges", () => {
  const organizationId = toSafeId<"organization">("fixture-org");
  const start = new Date("2021-03-04");
  for (const end of [
    start,
    new Date("2021-03-03"),
    new Date("2021-05-01"),
    new Date("invalid"),
  ]) {
    expect(() => actionCostReportQuery({ organizationId, start, end })).toThrow(
      "report period is invalid",
    );
  }
});
