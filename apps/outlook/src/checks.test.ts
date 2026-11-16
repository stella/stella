import { describe, expect, test } from "bun:test";

import {
  extractPotentialDates,
  extractQuestions,
  hasAttachmentMention,
  runReplyChecks,
} from "@/checks";
import { translator } from "@/i18n";
import type { MailSnapshot } from "@/types";

const snapshot = (overrides: Partial<MailSnapshot> = {}): MailSnapshot => ({
  attachments: [],
  bcc: [],
  bodyHtml: "",
  bodyText: "",
  cc: [],
  conversationId: null,
  from: null,
  internetMessageId: null,
  itemInstanceKey: "test-item",
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

describe("runReplyChecks", () => {
  test("flags recipients outside the user's domain while composing", () => {
    const checks = runReplyChecks({
      draft: "Thanks.",
      snapshot: snapshot({
        bcc: [{ email: "blind@external.com", name: "" }],
        mode: "compose",
        to: [
          { email: "outside@external.com", name: "" },
          { email: "us@ours.com", name: "" },
        ],
        userEmail: "us@ours.com",
      }),
      t: translator,
    });
    const external = checks.find((c) => c.title === "External recipients");
    expect(external?.type).toBe("warning");
    expect(external?.description).toContain("outside@external.com");
    expect(external?.description).toContain("blind@external.com");
    expect(external?.description).not.toContain("us@ours.com");
  });

  test("does not flag the sender a reply goes back to", () => {
    const checks = runReplyChecks({
      draft: "Thanks.",
      snapshot: snapshot({
        from: { email: "sender@external.com", name: "" },
        to: [{ email: "us@ours.com", name: "" }],
        userEmail: "us@ours.com",
      }),
      t: translator,
    });
    expect(checks).toEqual([]);
  });

  test("flags a draft that names an attachment the reply will not carry", () => {
    const fromRead = runReplyChecks({
      draft: "Please find the markup attached.",
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
      }),
      t: translator,
    });
    expect(fromRead.map((c) => c.title)).toEqual([
      "The draft mentions an attachment",
    ]);

    const composingWithFile = runReplyChecks({
      draft: "Please find the markup attached.",
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
        mode: "compose",
      }),
      t: translator,
    });
    expect(composingWithFile).toEqual([]);

    const composingWithInlineImageOnly = runReplyChecks({
      draft: "Please find the markup attached.",
      snapshot: snapshot({
        attachments: [
          {
            contentType: "image/png",
            id: "2",
            isInline: true,
            name: "logo.png",
            size: 1,
          },
        ],
        mode: "compose",
      }),
      t: translator,
    });
    expect(composingWithInlineImageOnly.map((c) => c.title)).toEqual([
      "The draft mentions an attachment",
    ]);
  });

  test("lists the dates the draft names", () => {
    const checks = runReplyChecks({
      draft: "We will come back to you by Friday, 14.11.",
      snapshot: snapshot({ bodyText: "Can you reply by Monday?" }),
      t: translator,
    });
    const dates = checks.find((c) => c.title === "Dates in the draft");
    expect(dates?.type).toBe("info");
    expect(dates?.description).toContain("Friday");
    expect(dates?.description).not.toContain("Monday");
  });

  test("says nothing when nothing needs a look", () => {
    expect(
      runReplyChecks({
        draft: "Thank you.",
        snapshot: snapshot(),
        t: translator,
      }),
    ).toEqual([]);
  });
});
