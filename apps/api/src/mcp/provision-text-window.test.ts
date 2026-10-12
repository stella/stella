import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { sha256Base64Url } from "@stll/sha256/bun";

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

  test("rechecksummed cursors accept exactly Unicode character boundaries", () => {
    const bmpText = fc
      .array(fc.integer({ min: 0, max: 0xd7_ff }), { maxLength: 8 })
      .map((points) => String.fromCodePoint(...points));
    assertProperty(
      "provision-text-cursors-unicode-boundaries",
      fc.property(
        bmpText,
        fc.integer({ min: 0x1_00_00, max: 0x10_ff_ff }),
        bmpText,
        (before, point, after) => {
          const subject = "unicode|provision";
          const text = `${before}${String.fromCodePoint(point)}${after}end`;
          const first = windowProvisionText({ limit: 2, subject, text });
          expect(first.type).toBe("window");
          if (first.type !== "window") {
            return;
          }
          expect(first.nextTextCursor).not.toBeNull();
          if (first.nextTextCursor === null) {
            return;
          }
          const [prefix, , binding] = first.nextTextCursor.split(".");
          expect(prefix).toBe("ptw1");
          expect(binding).toBeString();
          if (prefix === undefined || binding === undefined) {
            return;
          }
          const boundaries = new Set([0]);
          let position = 0;
          for (const character of text) {
            position += character.length;
            boundaries.add(position);
          }
          for (let offset = 0; offset <= text.length; offset += 1) {
            const payload = `${offset}.${binding}`;
            const cursor = `${prefix}.${payload}.${sha256Base64Url(payload)}`;
            const result = windowProvisionText({
              cursor,
              limit: 2,
              subject,
              text,
            });
            if (!boundaries.has(offset)) {
              expect(result).toEqual({ type: "invalid-cursor" });
              continue;
            }
            expect(result.type).toBe("window");
            if (result.type === "window") {
              expect(result.text.isWellFormed()).toBe(true);
            }
          }
        },
      ),
    );
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
