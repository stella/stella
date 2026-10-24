import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { sha256Base64Url } from "@stll/sha256/bun";

import { windowProvisionText } from "@/api/mcp/provision-text-window";

const readAll = (text: string, limit: number, subject = "eli|anchor") => {
  const chunks: string[] = [];
  let cursor: string | undefined;
  for (let step = 0; step <= text.length; step += 1) {
    const result = windowProvisionText({ cursor, limit, subject, text });
    expect(result.type).toBe("window");
    if (result.type !== "window") {
      return "";
    }
    if (result.nextTextCursor === null) {
      chunks.push(result.text);
      return chunks.join("");
    }
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.nextTextCursor).not.toBe(cursor);
    chunks.push(result.text);
    cursor = result.nextTextCursor;
  }
  expect(cursor).toBeUndefined();
  return chunks.join("");
};

describe("provision text windows", () => {
  test.each(["", "abcd"])("reconstructs bounded text %p", (text) => {
    expect(readAll(text, 4)).toBe(text);
  });

  test.each(["📚", "a📚b𐍈c", "\uD800x"])(
    "a one-unit budget reconstructs %p without repeating a cursor",
    (text) => {
      expect(readAll(text, 1)).toBe(text);
    },
  );

  test("positive budgets reconstruct bounded Unicode text with forward progress", () => {
    const point = fc.oneof(
      fc.integer({ min: 0, max: 0xd7_ff }),
      fc.integer({ min: 0x1_00_00, max: 0x10_ff_ff }),
    );
    assertProperty(
      "positive budgets reconstruct bounded Unicode text with forward progress",
      fc.property(
        fc.array(point, { maxLength: 12 }),
        fc.integer({ min: 1, max: 8 }),
        (points, limit) => {
          const text = String.fromCodePoint(...points);
          expect(readAll(text, limit)).toBe(text);
        },
      ),
    );
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
      "rechecksummed cursors accept exactly Unicode character boundaries",
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

  test.each(["1e0", "+1", " 1", "0x1"])(
    "refuses a rechecksummed non-decimal offset %s",
    (offset) => {
      const first = windowProvisionText({
        limit: 1,
        subject: "subject",
        text: "abc",
      });
      expect(first.type).toBe("window");
      if (first.type !== "window" || first.nextTextCursor === null) {
        panic("Expected another text window");
      }
      const [prefix, , binding] = first.nextTextCursor.split(".");
      if (prefix === undefined || binding === undefined) {
        panic("The text cursor fixture must contain a version and binding");
      }
      const payload = `${offset}.${binding}`;
      const cursor = `${prefix}.${payload}.${sha256Base64Url(payload)}`;
      expect(
        windowProvisionText({
          cursor,
          limit: 1,
          subject: "subject",
          text: "abc",
        }),
      ).toEqual({ type: "invalid-cursor" });
    },
  );

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
