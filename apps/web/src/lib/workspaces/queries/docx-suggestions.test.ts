import { describe, expect, test } from "bun:test";

import { readDocxSuggestionCreatedAt } from "@/lib/workspaces/queries/docx-suggestions";

describe("a suggestion createdAt read from the API", () => {
  test("the serialized timestamp the client receives reads back as the instant the server stamped", () => {
    const stamped = new Date("2026-09-15T11:30:00.123Z");
    const serialized = stamped.toISOString();

    const read = readDocxSuggestionCreatedAt(serialized);

    expect(read).toBeInstanceOf(Date);
    expect(read.getTime()).toBe(stamped.getTime());
  });

  test("an unreadable timestamp is a contract bug and panics", () => {
    expect(() => readDocxSuggestionCreatedAt("yesterday")).toThrow(
      "invalid createdAt",
    );
  });
});
