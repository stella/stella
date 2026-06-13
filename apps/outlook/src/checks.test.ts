import { describe, expect, test } from "bun:test";

import {
  extractPotentialDates,
  extractQuestions,
  hasAttachmentMention,
  runDraftChecks,
} from "@/checks";
import type { MailSnapshot } from "@/types";

const snapshot = (overrides: Partial<MailSnapshot> = {}): MailSnapshot => ({
  attachments: [],
  bodyText: "",
  cc: [],
  conversationId: null,
  from: null,
  internetMessageId: null,
  itemId: null,
  mode: "read",
  sentAt: null,
  subject: "",
  to: [],
  userEmail: null,
  ...overrides,
});

describe("hasAttachmentMention", () => {
  test("matches english attachment vocabulary case-insensitively", () => {
    expect(
      hasAttachmentMention(snapshot({ bodyText: "Please see ATTACHED file." })),
    ).toBe(true);
    expect(
      hasAttachmentMention(snapshot({ bodyText: "Document enclosed." })),
    ).toBe(true);
  });

  test("matches czech příloze (with and without diacritics)", () => {
    expect(
      hasAttachmentMention(
        snapshot({ bodyText: "Posílám v příloze smlouvu." }),
      ),
    ).toBe(true);
    expect(
      hasAttachmentMention(
        snapshot({ bodyText: "Posilam v priloze smlouvu." }),
      ),
    ).toBe(true);
  });

  test("returns false when no attachment word is present", () => {
    expect(
      hasAttachmentMention(
        snapshot({ bodyText: "Just a quick note, no files." }),
      ),
    ).toBe(false);
  });

  test("scans the subject line as well as the body", () => {
    expect(
      hasAttachmentMention(snapshot({ subject: "Files enclosed for review" })),
    ).toBe(true);
  });
});

describe("extractQuestions", () => {
  test("returns trimmed sentences ending with a question mark", () => {
    expect(
      extractQuestions(
        snapshot({
          bodyText:
            "We met yesterday. Are you free Tuesday? Also: can you sign by Friday?",
        }),
      ),
    ).toEqual(["Are you free Tuesday?", "Also: can you sign by Friday?"]);
  });

  test("caps at five questions", () => {
    const body = Array.from({ length: 8 }, (_, i) => `Q${i}?`).join(" ");
    expect(extractQuestions(snapshot({ bodyText: body }))).toHaveLength(5);
  });

  test("returns an empty array when there are no questions", () => {
    expect(
      extractQuestions(snapshot({ bodyText: "Just a statement." })),
    ).toEqual([]);
  });

  test("returns an empty array for empty body", () => {
    expect(extractQuestions(snapshot())).toEqual([]);
  });
});

describe("extractPotentialDates", () => {
  test("picks up weekday and month words case-insensitively", () => {
    expect(
      extractPotentialDates(
        snapshot({ bodyText: "Let's meet Monday or in MARCH." }),
      ),
    ).toEqual(expect.arrayContaining(["Monday", "MARCH"]));
  });

  test("picks up numeric date patterns with 1-2 digit components", () => {
    const result = extractPotentialDates(
      snapshot({ bodyText: "Deadlines: 12/03 and 1.6.2025." }),
    );
    expect(result).toEqual(expect.arrayContaining(["12/03", "1.6.2025"]));
  });

  test("deduplicates exact-case repeated matches", () => {
    const result = extractPotentialDates(
      snapshot({ bodyText: "Monday or Monday again on Monday?" }),
    );
    expect(result.filter((m) => m === "Monday")).toHaveLength(1);
  });

  test("caps at eight signals", () => {
    const body =
      "Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April";
    expect(extractPotentialDates(snapshot({ bodyText: body }))).toHaveLength(8);
  });

  test("returns an empty array for empty body", () => {
    expect(extractPotentialDates(snapshot())).toEqual([]);
  });
});

describe("runDraftChecks", () => {
  test("flags external recipients when domain differs from sender domain", () => {
    const checks = runDraftChecks({
      selectedWorkspaceId: "ws-1",
      snapshot: snapshot({
        to: [
          { email: "outside@external.com", name: "" },
          { email: "us@ours.com", name: "" },
        ],
        userEmail: "us@ours.com",
      }),
    });
    const external = checks.find((c) => c.title === "External recipients");
    expect(external?.type).toBe("risk");
    expect(external?.description).toContain("outside@external.com");
    expect(external?.description).not.toContain("us@ours.com");
  });

  test("skips external-recipient check when userEmail is missing", () => {
    const checks = runDraftChecks({
      selectedWorkspaceId: "ws-1",
      snapshot: snapshot({
        to: [{ email: "x@external.com", name: "" }],
        userEmail: null,
      }),
    });
    expect(checks.some((c) => c.title === "External recipients")).toBe(false);
  });

  test("flags 'attachment mentioned but missing' only when no attachments present", () => {
    const mentioned = runDraftChecks({
      selectedWorkspaceId: "ws-1",
      snapshot: snapshot({ bodyText: "See attached." }),
    });
    expect(
      mentioned.some((c) => c.title === "Possible missing attachment"),
    ).toBe(true);

    const withFile = runDraftChecks({
      selectedWorkspaceId: "ws-1",
      snapshot: snapshot({
        attachments: [
          {
            contentType: null,
            id: "1",
            isInline: false,
            name: "f.pdf",
            size: 1,
          },
        ],
        bodyText: "See attached.",
      }),
    });
    expect(
      withFile.some((c) => c.title === "Possible missing attachment"),
    ).toBe(false);
  });

  test("warns when no workspace is selected", () => {
    const checks = runDraftChecks({
      selectedWorkspaceId: null,
      snapshot: snapshot(),
    });
    expect(checks.some((c) => c.title === "No matter selected")).toBe(true);
  });

  test("returns the 'no issues' fallback when nothing fires", () => {
    const checks = runDraftChecks({
      selectedWorkspaceId: "ws-1",
      snapshot: snapshot({
        bodyText: "Short note without triggers.",
        to: [{ email: "x@ours.com", name: "" }],
        userEmail: "y@ours.com",
      }),
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.title).toBe("No issues found");
  });

  test("reports inline-attachment skip as an info note", () => {
    const checks = runDraftChecks({
      selectedWorkspaceId: "ws-1",
      snapshot: snapshot({
        attachments: [
          {
            contentType: null,
            id: "1",
            isInline: true,
            name: "logo.png",
            size: 1,
          },
        ],
      }),
    });
    const inline = checks.find((c) => c.title === "Inline attachment skipped");
    expect(inline?.type).toBe("info");
  });
});
