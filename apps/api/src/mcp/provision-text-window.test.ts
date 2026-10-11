import { describe, expect, test } from "bun:test";

import { windowProvisionText } from "@/api/mcp/provision-text-window";

const readAll = (text: string, limit: number, subject = "eli|anchor") => {
  const chunks: string[] = [];
  let cursor: string | undefined;
  do {
    const result = windowProvisionText({ cursor, limit, subject, text });
    expect(result.type).toBe("window");
    if (result.type !== "window") {
      return "";
    }
    chunks.push(result.text);
    cursor = result.nextTextCursor ?? undefined;
  } while (cursor !== undefined);
  return chunks.join("");
};

describe("provision text windows", () => {
  test.each(["", "abcd"])("reconstructs bounded text %p", (text) => {
    expect(readAll(text, 4)).toBe(text);
  });

  test("reconstructs every window exactly", () => {
    const text = "first 👩‍⚖️ 中文 second 📚 last";
    expect(readAll(text, 3)).toBe(text);
  });

  test("never splits surrogate pairs", () => {
    const first = windowProvisionText({
      limit: 2,
      subject: "subject",
      text: "a📚",
    });
    expect(first).toMatchObject({ text: "a", truncated: true });
    if (first.type !== "window" || first.nextTextCursor === null) {
      throw new Error("Expected another text window");
    }
    expect(
      windowProvisionText({
        cursor: first.nextTextCursor,
        limit: 2,
        subject: "subject",
        text: "a📚",
      }),
    ).toMatchObject({ text: "📚", truncated: false });
  });

  test("refuses tampered and foreign cursors", () => {
    const first = windowProvisionText({ limit: 1, subject: "one", text: "ab" });
    if (first.type !== "window" || first.nextTextCursor === null) {
      throw new Error("Expected another text window");
    }
    expect(
      windowProvisionText({
        cursor: `${first.nextTextCursor}x`,
        limit: 1,
        subject: "one",
        text: "ab",
      }),
    ).toEqual({ type: "invalid-cursor" });
    expect(
      windowProvisionText({
        cursor: first.nextTextCursor,
        limit: 1,
        subject: "two",
        text: "ab",
      }),
    ).toEqual({ type: "invalid-cursor" });
  });

  test("refuses a cursor once the same subject's text changes", () => {
    const first = windowProvisionText({ limit: 1, subject: "one", text: "ab" });
    if (first.type !== "window" || first.nextTextCursor === null) {
      throw new Error("Expected another text window");
    }
    expect(
      windowProvisionText({
        cursor: first.nextTextCursor,
        limit: 1,
        subject: "one",
        text: "ac",
      }),
    ).toEqual({ type: "invalid-cursor" });
  });
});
