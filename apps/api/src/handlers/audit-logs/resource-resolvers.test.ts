import { describe, expect, test } from "bun:test";

import { AUDIT_NAMED_RESOURCE_KINDS } from "@stll/api-contract/audit-log";

import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

import { deletedSnapshotName } from "./resource-resolvers";

const deleted = (old: Record<string, unknown>) => ({
  deleted: { old, new: null },
});

describe("deletedSnapshotName", () => {
  test("reads the name each named kind's delete event recorded", () => {
    expect(
      deletedSnapshotName(
        AUDIT_RESOURCE_TYPE.CONTACT,
        deleted({ displayName: "Jana Nováková" }),
      ),
    ).toBe("Jana Nováková");
    expect(
      deletedSnapshotName(
        AUDIT_RESOURCE_TYPE.INVOICE,
        deleted({ invoiceNumber: "2026-0042", totalAmount: "1200.00" }),
      ),
    ).toBe("2026-0042");
    expect(
      deletedSnapshotName(
        AUDIT_RESOURCE_TYPE.TEMPLATE,
        deleted({ name: "Kupní smlouva", s3Key: "templates/1.docx" }),
      ),
    ).toBe("Kupní smlouva");
  });

  test("every named kind has a snapshot key", () => {
    for (const kind of AUDIT_NAMED_RESOURCE_KINDS) {
      expect(() => deletedSnapshotName(kind, deleted({}))).not.toThrow();
    }
  });

  test("details the reader may not see name nothing", () => {
    expect(deletedSnapshotName(AUDIT_RESOURCE_TYPE.CONTACT, null)).toBeNull();
  });

  test("a kind without a name source, or a snapshot without a name, names nothing", () => {
    expect(
      deletedSnapshotName(
        AUDIT_RESOURCE_TYPE.CLAUSE,
        deleted({ name: "Governing law" }),
      ),
    ).toBeNull();
    expect(
      deletedSnapshotName(AUDIT_RESOURCE_TYPE.CONTACT, deleted({})),
    ).toBeNull();
    expect(
      deletedSnapshotName(
        AUDIT_RESOURCE_TYPE.CONTACT,
        deleted({ displayName: "  " }),
      ),
    ).toBeNull();
    expect(
      deletedSnapshotName(AUDIT_RESOURCE_TYPE.CONTACT, {
        deleted: { old: "Jana", new: null },
      }),
    ).toBeNull();
  });
});
