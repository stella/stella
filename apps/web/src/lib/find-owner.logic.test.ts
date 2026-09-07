import { describe, expect, test } from "bun:test";

import { resolveFindClaim } from "@/lib/find-owner.logic";
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
const DOCUMENT = candidate("document", "app");

/** Which surface won, for the cases that only care about precedence. */
const ownerOf = (...candidates: FindCandidate[]): FindOwner | null =>
  resolveFindClaim(candidates.map((c) => ({ candidate: c })))?.candidate
    .owner ?? null;

describe("resolveFindClaim", () => {
  test("leaves the shortcut to the browser when nothing is registered", () => {
    expect(ownerOf()).toBeNull();
  });

  test("gives an app surface the press wherever focus is", () => {
    expect(ownerOf(TABLE)).toBe("table");
  });

  test("prefers the inspector over the table while both reach the app", () => {
    expect(ownerOf(TABLE, INSPECTOR)).toBe("inspector");
    expect(ownerOf(INSPECTOR, TABLE)).toBe("inspector");
  });

  test("gives the table a press that landed in its own pane or bar", () => {
    // A docked inspector outranks the table by precedence alone; a press with
    // a grid cell focused, or the caret in the table's own find input, is the
    // table's whatever else is on screen.
    expect(ownerOf(INSPECTOR, { ...TABLE, containsTarget: true })).toBe(
      "table",
    );
  });

  test("gives the full view a press that landed in its editor", () => {
    // A document in full view sits beside the inspector. The reference preview
    // reaches the app, so by precedence alone it would take a press with the
    // caret in the editor and open its bar over Folio's dialog.
    expect(ownerOf(INSPECTOR, { ...DOCUMENT, containsTarget: true })).toBe(
      "document",
    );
  });

  test("prefers the inspector over the full view for a press outside both", () => {
    expect(ownerOf(DOCUMENT, INSPECTOR)).toBe("inspector");
    expect(ownerOf(INSPECTOR, DOCUMENT)).toBe("inspector");
  });

  test("gives the full view the page while the inspector is hidden", () => {
    // What Folio's own document-wide binding gave the reader: Cmd/Ctrl+F
    // anywhere on the page opens the dialog while nothing more specific is
    // on screen to claim it.
    expect(ownerOf(DOCUMENT, { ...INSPECTOR, reachable: false })).toBe(
      "document",
    );
  });

  test("passes over a pane surface the press landed outside", () => {
    expect(ownerOf(DOCX, TABLE)).toBe("table");
  });

  test("gives the press to the pane it landed in", () => {
    expect(ownerOf({ ...DOCX, containsTarget: true }, TABLE, INSPECTOR)).toBe(
      "docx",
    );
  });

  test("skips a surface that is off screen", () => {
    expect(ownerOf({ ...INSPECTOR, reachable: false }, TABLE)).toBe("table");
    expect(
      ownerOf({ ...DOCX, containsTarget: true, reachable: false }, TABLE),
    ).toBe("table");
  });

  test("leaves the press alone when every app surface is behind a modal", () => {
    expect(
      ownerOf(
        { ...TABLE, reachable: false },
        { ...INSPECTOR, reachable: false },
      ),
    ).toBeNull();
  });

  test("keeps a pane the press landed in, even with the app surfaces hidden", () => {
    expect(
      ownerOf(
        { ...DOCX, containsTarget: true },
        { ...TABLE, reachable: false },
      ),
    ).toBe("docx");
  });

  test("resolves two live instances of one surface to that surface", () => {
    expect(ownerOf(TABLE, TABLE)).toBe("table");
  });

  test("hands two live instances of one surface the one holding the press", () => {
    // Both registrations are the table and both are on screen, which is what a
    // route transition between two table views looks like for one key press.
    // The older one registered first; the press landed in the newer one.
    const stale = { candidate: TABLE, id: "stale" };
    const focused = {
      candidate: { ...TABLE, containsTarget: true },
      id: "focused",
    };

    expect(resolveFindClaim([stale, focused])?.id).toBe("focused");
    expect(resolveFindClaim([focused, stale])?.id).toBe("focused");
  });

  test("falls back to the first registration for a press outside them all", () => {
    // Nothing to tie-break on, so precedence order stands rather than the
    // press going nowhere.
    const first = { candidate: TABLE, id: "first" };
    const second = { candidate: TABLE, id: "second" };

    expect(resolveFindClaim([first, second])?.id).toBe("first");
  });

  test("passes over an unreachable instance of the winning surface", () => {
    // The hidden instance registered first and the winner is decided by owner,
    // so a registration filter that only checked the owner would pick it.
    const hidden = { candidate: { ...TABLE, reachable: false }, id: "hidden" };
    const live = { candidate: TABLE, id: "live" };

    expect(resolveFindClaim([hidden, live])?.id).toBe("live");
  });
});
