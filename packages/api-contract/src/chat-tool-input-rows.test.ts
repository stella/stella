import { describe, expect, test } from "bun:test";

import {
  getCompleteConnectorInputRows,
  getReadableInputRows,
  humanizeIdentifier,
} from "./chat-tool-input-rows";

const LABELS = { emptyLabel: "(empty)", requestLabel: "Input" };

describe("a tool call's input, as an approval shows it", () => {
  test("reads each field of an object under its humanized name", () => {
    expect(
      getReadableInputRows({
        ...LABELS,
        input: {
          command: "ls -la",
          working_dir: null,
          flags: ["--all", "--long"],
          options: { dry_run: true },
        },
      }),
    ).toEqual([
      { key: "command", label: "Command", value: "ls -la" },
      { key: "working_dir", label: "Working dir", value: "(empty)" },
      { key: "flags", label: "Flags", value: "--all, --long" },
      { key: "options", label: "Options", value: "Dry run: true" },
    ]);
  });

  test("reads a list item by item and anything else as one request", () => {
    expect(
      getReadableInputRows({ ...LABELS, input: ["first", 2] }).map(
        ({ label, value }) => [label, value],
      ),
    ).toEqual([
      ["1", "first"],
      ["2", "2"],
    ]);
    expect(getReadableInputRows({ ...LABELS, input: "rm -rf build" })).toEqual([
      { key: "request", label: "Input", value: "rm -rf build" },
    ]);
  });

  test("cuts a long value, so one field cannot fill the card", () => {
    const [row] = getReadableInputRows({
      ...LABELS,
      input: { text: "x".repeat(500) },
    });
    expect(row?.value).toBe(`${"x".repeat(200)}…`);
  });

  test("names identifiers in words", () => {
    expect(humanizeIdentifier("mcp__external__delete")).toBe(
      "Mcp external delete",
    );
    expect(humanizeIdentifier("request-user_input")).toBe("Request user input");
  });
});

describe("a credential-backed call's input, as an approval shows it", () => {
  // The connector receives exactly these arguments once the call is approved.
  const recipients = Array.from(
    { length: 30 },
    (_, index) => `recipient-${String(index)}@example.test`,
  );
  const input = {
    body: "x".repeat(400),
    to: { recipients },
  };

  test("shows every argument in full, nested ones included", () => {
    const rows = getCompleteConnectorInputRows({ ...LABELS, input });
    expect(rows).toEqual([
      { key: "body", label: "Body", value: "x".repeat(400) },
      {
        key: "to",
        label: "To",
        value: JSON.stringify({ recipients }, null, 2),
      },
    ]);
  });

  test("where the generic summary would shorten them", () => {
    const rows = getReadableInputRows({ ...LABELS, input });
    expect(rows.find((row) => row.key === "body")?.value.length).toBeLessThan(
      400,
    );
  });
});
