import { expect, test } from "bun:test";

import { accountExportStatus } from "@/api/lib/account-export/store";

test("status reads present elapsed exports without changing their ledger state", () => {
  const row = {
    id: "0199d851-071b-7000-8000-000000000001",
    status: "ready",
    expiresAt: new Date("2000-01-01T00:00:00.000Z"),
  } as const satisfies Parameters<typeof accountExportStatus>[0];
  expect(accountExportStatus(row)).toEqual({ id: row.id, status: "expired" });
  expect(row.status).toBe("ready");
});

test("status reads preserve the expiry of a ready export", () => {
  const row = {
    id: "0199d851-071b-7000-8000-000000000001",
    status: "ready",
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  } as const satisfies Parameters<typeof accountExportStatus>[0];
  expect(accountExportStatus(row)).toEqual(row);
});

test.each(["requested", "processing", "failed", "expired"] as const)(
  "%s status reads do not expose download metadata",
  (status) => {
    const id = "0199d851-071b-7000-8000-000000000001";
    expect(accountExportStatus({ id, status, expiresAt: null })).toEqual({
      id,
      status,
    });
  },
);
