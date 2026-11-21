import { describe, expect, test } from "bun:test";

import { auditLogExportCsvLine } from "@/api/lib/audit-log-export";
import type { AuditLogExportRow } from "@/api/lib/audit-log-export";

const context = {
  featureAccessSnapshot: undefined,
  principal: { organizationId: "org-1", userId: "reader-1" },
};

const row = (
  performer: Pick<AuditLogExportRow, "performerType" | "performerName">,
): AuditLogExportRow => ({
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
  userId: "user-1",
  ...performer,
  action: "workspace.archived",
  resourceType: "workspace",
  matterReadable: false,
});

const nameColumn = (line: string) => line.split(",")[2];

describe("audit log export actor", () => {
  test("an automation row names the automation, not the member it ran for", () => {
    expect(
      nameColumn(
        auditLogExportCsvLine({
          row: row({ performerType: "service", performerName: "Nightly sync" }),
          actor: { name: "Member Name", email: "member@example.invalid" },
          ...context,
        }),
      ),
    ).toBe("Nightly sync");
  });

  test.each(["user", "agent"] as const)(
    "a %s row names the member even when a performer name is stored",
    (performerType) => {
      expect(
        nameColumn(
          auditLogExportCsvLine({
            row: row({ performerType, performerName: "Recorded name" }),
            actor: { name: "Member Name", email: "member@example.invalid" },
            ...context,
          }),
        ),
      ).toBe("Member Name");
    },
  );

  test("an automation without a recorded name falls back to the member", () => {
    expect(
      nameColumn(
        auditLogExportCsvLine({
          row: row({ performerType: "service", performerName: null }),
          actor: { name: "Member Name", email: "member@example.invalid" },
          ...context,
        }),
      ),
    ).toBe("Member Name");
  });
});
