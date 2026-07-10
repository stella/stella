import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

const PersonSchema = v.strictObject({
  age: v.number(),
  name: v.string(),
});

describe("readStoredJson", () => {
  test("returns null for a missing key (raw is null)", () => {
    expect(readStoredJson(null, PersonSchema)).toBeNull();
  });

  test("returns null for corrupted JSON", () => {
    expect(readStoredJson("not json at all", PersonSchema)).toBeNull();
    expect(readStoredJson("{truncated", PersonSchema)).toBeNull();
  });

  test("returns null when the parsed value does not match the schema", () => {
    expect(
      readStoredJson(JSON.stringify({ age: "old", name: "a" }), PersonSchema),
    ).toBeNull();
    expect(
      readStoredJson(JSON.stringify({ name: "a" }), PersonSchema),
    ).toBeNull();
    expect(readStoredJson(JSON.stringify([1, 2, 3]), PersonSchema)).toBeNull();
  });

  test("returns null for an object with unknown keys under a strict schema", () => {
    expect(
      readStoredJson(
        JSON.stringify({ age: 1, extra: true, name: "a" }),
        PersonSchema,
      ),
    ).toBeNull();
  });

  test("returns the typed value on a valid round trip", () => {
    const stored = JSON.stringify({ age: 30, name: "Ada" });
    expect(readStoredJson(stored, PersonSchema)).toEqual({
      age: 30,
      name: "Ada",
    });
  });

  test("validates array schemas the same way", () => {
    const schema = v.array(v.string());
    expect(readStoredJson(JSON.stringify(["a", "b"]), schema)).toEqual([
      "a",
      "b",
    ]);
    expect(readStoredJson(JSON.stringify(["a", 1]), schema)).toBeNull();
  });
});

class ThrowingStorage implements Storage {
  length = 0;
  clear(): void {
    // no-op
  }
  getItem(): string | null {
    return null;
  }
  key(): string | null {
    return null;
  }
  removeItem(): void {
    // no-op
  }
  setItem(): void {
    throw new DOMException("QuotaExceededError");
  }
}

describe("writeStoredJson", () => {
  test("round-trips through readStoredJson", () => {
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    } as unknown as Storage;

    writeStoredJson(fakeStorage, "person", { age: 30, name: "Ada" });
    const raw = fakeStorage.getItem("person");
    expect(readStoredJson(raw, PersonSchema)).toEqual({ age: 30, name: "Ada" });
  });

  test("swallows storage errors (quota exceeded, unavailable)", () => {
    const storage = new ThrowingStorage();
    expect(() => writeStoredJson(storage, "key", { a: 1 })).not.toThrow();
  });
});
