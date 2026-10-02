import { describe, expect, test } from "bun:test";

import { lapsedAcceptances } from "./dependency-audit-acceptance";

const advisory = { id: "GHSA-aaaa-bbbb-cccc", vulnerableVersions: "<=1.4.0" };
const latest = (version: string | undefined) => () => version;

describe("audit acceptance expiry", () => {
  test("an acceptance without terms never lapses", () => {
    expect(
      lapsedAcceptances({
        accepted: [{ id: advisory.id, package: "pkg" }],
        current: [advisory],
        today: "2099-01-01",
        latestVersion: latest(undefined),
      }),
    ).toEqual([]);
  });

  test("an acceptance lapses after its expiry date, not on it", () => {
    const accepted = [
      { id: advisory.id, package: "pkg", expiresOn: "2026-11-01" },
    ];
    for (const today of ["2026-10-02", "2026-11-01"]) {
      expect(
        lapsedAcceptances({
          accepted,
          current: [advisory],
          today,
          latestVersion: latest("1.4.0"),
        }),
      ).toEqual([]);
    }
    expect(
      lapsedAcceptances({
        accepted,
        current: [advisory],
        today: "2026-11-02",
        latestVersion: latest("1.4.0"),
      }).map(({ reason }) => reason),
    ).toEqual(["the acceptance expired on 2026-11-01"]);
  });

  test("a malformed or impossible expiry date fails closed", () => {
    for (const expiresOn of ["1 Nov 2026", "2026-13-45", "2026-02-30", ""]) {
      expect(
        lapsedAcceptances({
          accepted: [{ id: advisory.id, package: "pkg", expiresOn }],
          current: [advisory],
          today: "2026-10-02",
          latestVersion: latest("1.4.0"),
        }),
        expiresOn,
      ).toHaveLength(1);
    }
    expect(
      lapsedAcceptances({
        accepted: [
          { id: advisory.id, package: "pkg", expiresOn: "2028-02-29" },
        ],
        current: [advisory],
        today: "2026-10-02",
        latestVersion: latest("1.4.0"),
      }),
    ).toEqual([]);
  });

  test("a non-boolean untilPatched fails closed", () => {
    for (const untilPatched of ["true", 1, null]) {
      expect(
        lapsedAcceptances({
          accepted: [{ id: advisory.id, package: "pkg", untilPatched }],
          current: [advisory],
          today: "2026-10-02",
          latestVersion: latest("1.4.0"),
        }).map(({ reason }) => reason),
      ).toEqual(["untilPatched must be true or false"]);
    }
  });

  test("untilPatched lapses once the latest release is outside the vulnerable range", () => {
    const accepted = [{ id: advisory.id, package: "pkg", untilPatched: true }];
    expect(
      lapsedAcceptances({
        accepted,
        current: [advisory],
        today: "2026-10-02",
        latestVersion: latest("1.4.0"),
      }),
    ).toEqual([]);
    const lapsed = lapsedAcceptances({
      accepted,
      current: [advisory],
      today: "2026-10-02",
      latestVersion: latest("1.4.1"),
    });
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]?.reason).toContain("a patched release exists");
  });

  test("untilPatched fails closed when the lookup or the range is missing", () => {
    const accepted = [{ id: advisory.id, package: "pkg", untilPatched: true }];
    expect(
      lapsedAcceptances({
        accepted,
        current: [advisory],
        today: "2026-10-02",
        latestVersion: latest(undefined),
      }),
    ).toHaveLength(1);
    expect(
      lapsedAcceptances({
        accepted,
        current: [{ id: advisory.id, vulnerableVersions: "" }],
        today: "2026-10-02",
        latestVersion: latest("1.4.0"),
      }),
    ).toHaveLength(1);
  });

  test("a temporary acceptance lapses once its advisory is no longer reported", () => {
    for (const terms of [{ untilPatched: true }, { expiresOn: "2026-11-01" }]) {
      expect(
        lapsedAcceptances({
          accepted: [{ id: advisory.id, package: "pkg", ...terms }],
          current: [],
          today: "2026-10-02",
          latestVersion: latest("1.4.0"),
        }).map(({ reason }) => reason),
      ).toEqual(["the advisory is no longer reported; remove the acceptance"]);
    }
    expect(
      lapsedAcceptances({
        accepted: [{ id: advisory.id, package: "pkg" }],
        current: [],
        today: "2026-10-02",
        latestVersion: latest("1.4.0"),
      }),
    ).toEqual([]);
  });
});
