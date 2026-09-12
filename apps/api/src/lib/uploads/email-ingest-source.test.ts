import { describe, expect, test } from "bun:test";

import { deriveOutlookEmailSourceKey } from "@/api/lib/uploads/email-ingest-source";

const sourceId = "00000000-0000-7000-8000-000000000001";

describe("deriveOutlookEmailSourceKey", () => {
  test("normalizes mailbox casing without retaining source material", () => {
    const first = deriveOutlookEmailSourceKey({
      source: { mailboxEmail: " Lawyer@Example.Org ", sourceId },
    });
    const second = deriveOutlookEmailSourceKey({
      source: { mailboxEmail: "lawyer@example.org", sourceId },
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toContain("lawyer");
    expect(first).not.toContain(sourceId);
  });

  test("separates identities for different Outlook items", () => {
    expect(
      deriveOutlookEmailSourceKey({
        source: { mailboxEmail: "lawyer@example.org", sourceId },
      }),
    ).not.toBe(
      deriveOutlookEmailSourceKey({
        source: {
          mailboxEmail: "lawyer@example.org",
          sourceId: "00000000-0000-7000-8000-000000000002",
        },
      }),
    );
  });
});
