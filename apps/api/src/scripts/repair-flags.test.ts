/**
 * What an operator types has to mean what they meant. These flags bound a run
 * that writes, so a spelling the reader does not recognise is not a cosmetic
 * miss: an unread `--limit` leaves the caller's default standing, and the
 * default is thousands of rows.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  flagInteger,
  hasFlag,
  readApplyFlag,
} from "@/api/scripts/repair-flags";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
});

const withArgs = (...args: string[]): void => {
  process.argv = ["bun", "repair.ts", ...args];
};

const limit = (): number =>
  flagInteger({ fallback: 5000, name: "limit", usage: "usage" });

describe("flagInteger", () => {
  test("reads the spelling the usage texts document", () => {
    withArgs("--apply", "--limit", "10");
    expect(limit()).toBe(10);
  });

  test("reads the inline spelling a shell user reaches for", () => {
    withArgs("--apply", "--limit=10");
    expect(limit()).toBe(10);
  });

  test("falls back only when the flag is absent altogether", () => {
    withArgs("--apply");
    expect(limit()).toBe(5000);
  });

  test("does not read one flag's value off another's name", () => {
    withArgs("--limit=7", "--batch=9");
    expect(limit()).toBe(7);
    expect(flagInteger({ fallback: 1, name: "batch", usage: "usage" })).toBe(9);
  });
});

describe("readApplyFlag", () => {
  test("a run writes only when it was asked to", () => {
    withArgs("--limit=10");
    expect(readApplyFlag("usage")).toBe(false);
    withArgs("--apply", "--limit=10");
    expect(readApplyFlag("usage")).toBe(true);
  });

  test("the inline spelling of another flag is not an apply", () => {
    withArgs("--dry-run", "--limit=10");
    expect(hasFlag("apply")).toBe(false);
    expect(readApplyFlag("usage")).toBe(false);
  });
});
