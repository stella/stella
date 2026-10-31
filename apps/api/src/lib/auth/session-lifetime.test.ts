import { describe, expect, test } from "bun:test";

import { decidePinnedSessionLifetime } from "./session-lifetime";

describe("pinned session lifetime", () => {
  test("leaves framework create input without generated fields unpinned", () => {
    expect(decidePinnedSessionLifetime({})).toBeUndefined();
  });

  test("pins monitoring sessions for 30 minutes from creation", () => {
    const createdAt = new Date("2026-10-19T12:00:00.000Z");

    expect(
      decidePinnedSessionLifetime({
        id: "synthetic-session-example",
        createdAt,
      }),
    ).toEqual({
      refreshMode: "fixed",
      expiresAt: new Date("2026-10-19T12:30:00.000Z"),
    });
  });
});
