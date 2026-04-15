import { describe, expect, test } from "bun:test";

import { isSorted, sortKeys, syncMessages } from "./i18n-check";
import type { NestedMessages } from "./i18n-check";

describe("syncMessages", () => {
  test("adds missing top-level keys", () => {
    const source: NestedMessages = {
      greeting: "Hello",
      farewell: "Goodbye",
    };
    const target: NestedMessages = { greeting: "Ahoj" };

    const result = syncMessages(source, target);

    expect(result).toEqual({
      farewell: "Goodbye",
      greeting: "Ahoj",
    });
  });

  test("adds missing nested keys", () => {
    const source: NestedMessages = {
      auth: { login: "Log in", logout: "Log out" },
    };
    const target: NestedMessages = {};

    const result = syncMessages(source, target);

    expect(result).toEqual({
      auth: { login: "Log in", logout: "Log out" },
    });
  });

  test("removes extra top-level keys", () => {
    const source: NestedMessages = { greeting: "Hello" };
    const target: NestedMessages = {
      greeting: "Ahoj",
      obsolete: "Old value",
    };

    const result = syncMessages(source, target);

    expect(result).toEqual({ greeting: "Ahoj" });
  });

  test("removes extra nested keys and cleans empty parents", () => {
    const source: NestedMessages = { greeting: "Hello" };
    const target: NestedMessages = {
      greeting: "Ahoj",
      auth: { old: "Stará hodnota" },
    };

    const result = syncMessages(source, target);

    expect(result).toEqual({ greeting: "Ahoj" });
  });

  test("preserves existing translations", () => {
    const source: NestedMessages = {
      greeting: "Hello",
      auth: { login: "Log in" },
    };
    const target: NestedMessages = {
      greeting: "Ahoj",
      auth: { login: "Přihlásit se" },
    };

    const result = syncMessages(source, target);

    expect(result).toEqual({
      auth: { login: "Přihlásit se" },
      greeting: "Ahoj",
    });
  });

  test("handles additions and removals in one call", () => {
    const source: NestedMessages = {
      greeting: "Hello",
      auth: { login: "Log in" },
    };
    const target: NestedMessages = {
      greeting: "Ahoj",
      obsolete: "Starý",
      auth: { login: "Přihlásit se", old: "Staré" },
    };

    const result = syncMessages(source, target);

    expect(result).toEqual({
      auth: { login: "Přihlásit se" },
      greeting: "Ahoj",
    });
  });

  test("returns sorted object when already in sync", () => {
    const source: NestedMessages = {
      greeting: "Hello",
      auth: { login: "Log in" },
    };
    const target: NestedMessages = {
      greeting: "Ahoj",
      auth: { login: "Přihlásit se" },
    };

    const result = syncMessages(source, target);

    expect(result).toEqual({
      auth: { login: "Přihlásit se" },
      greeting: "Ahoj",
    });
    expect(Object.keys(result)).toEqual(["auth", "greeting"]);
  });

  test("does not mutate the original target", () => {
    const source: NestedMessages = { greeting: "Hello" };
    const target: NestedMessages = { obsolete: "Old" };
    const originalTarget = structuredClone(target);

    syncMessages(source, target);

    expect(target).toEqual(originalTarget);
  });
});

describe("sortKeys", () => {
  test("sorts top-level keys alphabetically", () => {
    const input: NestedMessages = {
      zebra: "Z",
      apple: "A",
      mango: "M",
    };

    const result = sortKeys(input);

    expect(Object.keys(result)).toEqual(["apple", "mango", "zebra"]);
  });

  test("sorts nested keys recursively", () => {
    const input: NestedMessages = {
      z: { beta: "B", alpha: "A" },
      a: "first",
    };

    const result = sortKeys(input);

    expect(Object.keys(result)).toEqual(["a", "z"]);
    const z = result.z;
    expect(z).toBeDefined();
    expect(typeof z === "object" && Object.keys(z)).toEqual(["alpha", "beta"]);
  });

  test("preserves values while sorting", () => {
    const input: NestedMessages = {
      b: "two",
      a: "one",
    };

    const result = sortKeys(input);

    expect(result).toEqual({ a: "one", b: "two" });
  });
});

describe("isSorted", () => {
  test("returns true for sorted top-level keys", () => {
    expect(isSorted({ a: "1", b: "2", c: "3" })).toBe(true);
  });

  test("returns false for unsorted top-level keys", () => {
    expect(isSorted({ b: "2", a: "1" })).toBe(false);
  });

  test("returns true for sorted nested keys", () => {
    expect(isSorted({ a: { x: "1", y: "2" }, b: "3" })).toBe(true);
  });

  test("returns false for unsorted nested keys", () => {
    expect(isSorted({ a: { y: "2", x: "1" }, b: "3" })).toBe(false);
  });

  test("returns true for empty object", () => {
    expect(isSorted({})).toBe(true);
  });

  test("returns true for single key", () => {
    expect(isSorted({ only: "one" })).toBe(true);
  });
});
