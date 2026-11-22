import { describe, expect, test } from "bun:test";

import {
  documentNamePatternProblem,
  renderDocumentName,
} from "./document-name";

const ALL = {
  date: "2026-03-14",
  matterNumber: "2026-042",
  docType: "Ruling",
  title: "Motion to dismiss",
};
const NONE = { date: null, matterNumber: null, docType: null, title: null };

describe("renderDocumentName", () => {
  test("fills every token and keeps the extension", () => {
    expect(
      renderDocumentName({
        pattern: "{date}_{matterNumber}_{docType}_{title}",
        values: ALL,
        extension: ".pdf",
      }),
    ).toBe("2026-03-14_2026-042_Ruling_Motion to dismiss.pdf");
  });

  test("renders the compact date", () => {
    expect(
      renderDocumentName({
        pattern: "{dateCompact} {title}",
        values: ALL,
        extension: ".docx",
      }),
    ).toBe("20260314 Motion to dismiss.docx");
  });

  test("drops a missing token with the separator before it", () => {
    expect(
      renderDocumentName({
        pattern: "{matterNumber}_{docType}_{title}",
        values: { ...ALL, docType: null },
        extension: ".pdf",
      }),
    ).toBe("2026-042_Motion to dismiss.pdf");
  });

  test("drops a missing leading token with the separator after it", () => {
    expect(
      renderDocumentName({
        pattern: "{date} - {title}",
        values: { ...ALL, date: null },
        extension: ".pdf",
      }),
    ).toBe("Motion to dismiss.pdf");
  });

  test("keeps literal text that is not a separator", () => {
    expect(
      renderDocumentName({
        pattern: "Matter {matterNumber} {title}",
        values: { ...ALL, matterNumber: null },
        extension: "",
      }),
    ).toBe("Matter Motion to dismiss");
  });

  test("replaces characters a file name cannot hold", () => {
    expect(
      renderDocumentName({
        pattern: "{title}",
        values: { ...NONE, title: 'A/B: "draft"\n<v2>' },
        extension: ".pdf",
      }),
    ).toBe("A B draft v2.pdf");
  });

  test("trims a long run of edge separators in linear time", () => {
    const run = "_".repeat(100_000);
    expect(
      renderDocumentName({
        pattern: `{title}${run}`,
        values: { ...NONE, title: `${run}Lease${run}` },
        extension: ".pdf",
      }),
    ).toBe("Lease.pdf");
  });

  test("returns null when no token has a value", () => {
    expect(
      renderDocumentName({
        pattern: "{date}_{title}",
        values: NONE,
        extension: ".pdf",
      }),
    ).toBeNull();
  });
});

describe("documentNamePatternProblem", () => {
  test("accepts a pattern of known tokens and separators", () => {
    expect(
      documentNamePatternProblem("{date}_{matterNumber}_{docType}_{title}"),
    ).toBeNull();
  });

  test.each([
    ["{party}_{title}", "Unrecognized token: {party}"],
    ["{title", "Pattern must not contain unmatched or nested braces"],
    ["{date}/{title}", 'Pattern must not contain \\ / : * ? " < > |'],
    ["plain name", "Pattern must contain at least one token"],
    [`{title}${"x".repeat(130)}`, "Pattern must be at most 128 characters"],
  ])("rejects %p", (pattern, problem) => {
    expect(documentNamePatternProblem(pattern)).toBe(problem);
  });
});
