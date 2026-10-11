import { expect, test } from "bun:test";

import {
  serviceResolveAuditCountry,
  serviceResolveAuditOutcome,
} from "./service-audit";

test("resolve audits normalize countries and preserve typed outcomes", () => {
  expect(serviceResolveAuditCountry("cz")).toBe("CZE");
  expect(serviceResolveAuditCountry("untrusted text")).toBe("unknown");
  expect(
    serviceResolveAuditOutcome({ status: "country_unavailable" }, 200),
  ).toBe("country_unavailable");
  expect(serviceResolveAuditOutcome("rate-limit reached", 429)).toBe(
    "rate_limited",
  );
  expect(serviceResolveAuditOutcome({ error: "not_entitled" }, 403)).toBe(
    "not_entitled",
  );
  expect(
    serviceResolveAuditOutcome({ status: "country_unavailable" }, 500),
  ).toBe("error");
});
