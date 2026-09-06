import { describe, expect, test } from "bun:test";

import { resolveFindOwner } from "@/lib/find-owner.logic";
import type {
  FindCandidate,
  FindOwner,
  FindScope,
} from "@/lib/find-owner.logic";

const candidate = (
  owner: FindOwner,
  scope: FindScope,
  overrides: Partial<FindCandidate> = {},
): FindCandidate => ({
  containsTarget: false,
  owner,
  reachable: true,
  scope,
  ...overrides,
});

const TABLE = candidate("table", "app");
const INSPECTOR = candidate("inspector", "app");
const DOCX = candidate("docx", "pane");

describe("resolveFindOwner", () => {
  test("leaves the shortcut to the browser when nothing is registered", () => {
    expect(resolveFindOwner([])).toBeNull();
  });

  test("gives an app surface the press wherever focus is", () => {
    expect(resolveFindOwner([TABLE])).toBe("table");
  });

  test("prefers the inspector over the table while both reach the app", () => {
    expect(resolveFindOwner([TABLE, INSPECTOR])).toBe("inspector");
    expect(resolveFindOwner([INSPECTOR, TABLE])).toBe("inspector");
  });

  test("passes over a pane surface the press landed outside", () => {
    expect(resolveFindOwner([DOCX, TABLE])).toBe("table");
  });

  test("gives the press to the pane it landed in", () => {
    expect(
      resolveFindOwner([{ ...DOCX, containsTarget: true }, TABLE, INSPECTOR]),
    ).toBe("docx");
  });

  test("skips a surface that is off screen", () => {
    expect(resolveFindOwner([{ ...INSPECTOR, reachable: false }, TABLE])).toBe(
      "table",
    );
    expect(
      resolveFindOwner([
        { ...DOCX, containsTarget: true, reachable: false },
        TABLE,
      ]),
    ).toBe("table");
  });

  test("leaves the press alone when every app surface is behind a modal", () => {
    expect(
      resolveFindOwner([
        { ...TABLE, reachable: false },
        { ...INSPECTOR, reachable: false },
      ]),
    ).toBeNull();
  });

  test("keeps a pane the press landed in, even with the app surfaces hidden", () => {
    expect(
      resolveFindOwner([
        { ...DOCX, containsTarget: true },
        { ...TABLE, reachable: false },
      ]),
    ).toBe("docx");
  });

  test("resolves two live instances of one surface to that surface", () => {
    expect(resolveFindOwner([TABLE, TABLE])).toBe("table");
  });
});
