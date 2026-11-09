import { describe, expect, test } from "bun:test";

import {
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
