import { describe, expect, test } from "bun:test";

import { planClauseVersionSnapshot } from "./update";

describe("planClauseVersionSnapshot", () => {
  test("autosave (snapshotVersion falsy) never snapshots, even with a body", () => {
    expect(
      planClauseVersionSnapshot({
        snapshotVersion: undefined,
        hasBody: true,
        bodyEqualsLatestSnapshot: false,
      }),
    ).toBe(false);

    expect(
      planClauseVersionSnapshot({
        snapshotVersion: false,
        hasBody: true,
        bodyEqualsLatestSnapshot: false,
      }),
    ).toBe(false);
  });

  test("explicit snapshotVersion:true snapshots when the body differs from the latest version", () => {
    expect(
      planClauseVersionSnapshot({
        snapshotVersion: true,
        hasBody: true,
        bodyEqualsLatestSnapshot: false,
      }),
    ).toBe(true);
  });

  test("no-op guard: skips the snapshot when the body equals the latest stored version", () => {
    expect(
      planClauseVersionSnapshot({
        snapshotVersion: true,
        hasBody: true,
        bodyEqualsLatestSnapshot: true,
      }),
    ).toBe(false);
  });

  test("never snapshots when no body is sent (e.g. a title-only update)", () => {
    expect(
      planClauseVersionSnapshot({
        snapshotVersion: true,
        hasBody: false,
        bodyEqualsLatestSnapshot: false,
      }),
    ).toBe(false);
  });
});
