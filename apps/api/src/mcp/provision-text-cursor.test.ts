import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { isRecord } from "@/api/lib/type-guards";
import { LEGISLATION_TOOL_SET } from "@/api/mcp/legislation-tools";
import {
  isProvisionTextCursor,
  windowProvisionText,
} from "@/api/mcp/provision-text-window";

const ELI = "https://www.e-sbirka.cz/eli/cz/sb/2012/89";
const ANCHOR = "par_1729";
const DOCUMENT_ID = "6f1c3a52-0000-4000-8000-000000000001";
const SUBJECT = JSON.stringify([ELI, ANCHOR, DOCUMENT_ID]);
const TOOLS = ["read_statute_provisions", "read_provision_history"] as const;

type ParseCursorOptions = {
  toolName: (typeof TOOLS)[number];
  cursor: string;
  eli?: string;
  anchor?: string;
};

const parseCursor = ({
  toolName,
  cursor,
  eli = ELI,
  anchor = ANCHOR,
}: ParseCursorOptions) => {
  const definition =
    LEGISLATION_TOOL_SET.definitions.find(({ name }) => name === toolName) ??
    panic("Missing provision tool definition");
  const entry = { eli, anchor, text_cursor: cursor };
  const parsed = v.parse(
    definition.inputSchemaSource,
    toolName === "read_statute_provisions" ? { items: [entry] } : entry,
  );
  const result =
    "items" in parsed && Array.isArray(parsed.items)
      ? parsed.items.at(0)
      : parsed;
  if (!isRecord(result)) {
    return panic("Missing parsed provision input");
  }
  if (!("text_cursor" in result)) {
    return undefined;
  }
  const value = result.text_cursor;
  if (value !== undefined && typeof value !== "string") {
    return panic("Unexpected parsed text cursor type");
  }
  return value;
};

const issuedCursor = (subject = SUBJECT) => {
  const window = windowProvisionText({ limit: 3, subject, text: "abcdefgh" });
  if (window.type !== "window" || window.nextTextCursor === null) {
    return panic("Expected a provision continuation");
  }
  return window.nextTextCursor;
};

describe.each(TOOLS)("%s provision text cursor boundary", (toolName) => {
  test("preserves an issued cursor unchanged", () => {
    const cursor = issuedCursor();
    expect(isProvisionTextCursor(cursor)).toBe(true);
    expect(parseCursor({ toolName, cursor })).toBe(cursor);
  });

  test("preserves cursors at the address length limits", () => {
    const eli = "e".repeat(512);
    const anchor = "a".repeat(256);
    const subject = JSON.stringify([eli, anchor, DOCUMENT_ID]);
    const cursor = issuedCursor(subject);
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(parseCursor({ toolName, cursor, eli, anchor })).toBe(cursor);
    expect(
      windowProvisionText({ cursor, limit: 3, subject, text: "abcdefgh" }),
    ).toMatchObject({ type: "window", text: "def" });
  });

  test("reconstructs wording through the tool schema and text windows", () => {
    const text = "first 👩‍⚖️ 中文 second 📚 last";
    const chunks: string[] = [];
    let cursor: string | undefined;
    for (let index = 0; index <= text.length; index += 1) {
      const window = windowProvisionText({
        cursor,
        limit: 3,
        subject: SUBJECT,
        text,
      });
      if (window.type !== "window") {
        panic("Expected a provision text window");
      }
      chunks.push(window.text);
      if (window.nextTextCursor === null) {
        expect(chunks.join("")).toBe(text);
        return;
      }
      cursor = parseCursor({ toolName, cursor: window.nextTextCursor });
      expect(cursor).toBe(window.nextTextCursor);
    }
    panic("Provision text continuation did not finish");
  });

  test.each([
    ["malformed", "ptw1.invalid"],
    ["truncated", issuedCursor().slice(0, -1)],
    ["tampered", `${issuedCursor()}x`],
    [
      "other ELI",
      issuedCursor(JSON.stringify([`${ELI}/other`, ANCHOR, DOCUMENT_ID])),
    ],
    [
      "other anchor",
      issuedCursor(JSON.stringify([ELI, "par_1730", DOCUMENT_ID])),
    ],
    [
      "other document",
      issuedCursor(
        JSON.stringify([ELI, ANCHOR, "6f1c3a52-0000-4000-8000-000000000002"]),
      ),
    ],
  ])("refuses a %s cursor after schema parsing", (_kind, cursor) => {
    const parsed = parseCursor({ toolName, cursor });
    expect(parsed).toBe(cursor);
    expect(
      windowProvisionText({
        cursor: parsed,
        limit: 3,
        subject: SUBJECT,
        text: "abcdefgh",
      }),
    ).toEqual({ type: "invalid-cursor" });
  });

  test.each(["start", "0", " "])(
    "reads placeholder %p as absence",
    (cursor) => {
      expect(isProvisionTextCursor(cursor)).toBe(false);
      expect(parseCursor({ toolName, cursor })).toBeUndefined();
    },
  );
});
