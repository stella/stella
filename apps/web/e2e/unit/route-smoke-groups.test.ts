import { describe, expect, test } from "bun:test";

import { E2E_EXECUTION_PROFILE } from "../execution-profile";
import { resolveRouteSmokeGroupCount } from "../helpers/route-smoke-groups";

describe("route smoke group count resolution", () => {
  test("resolves route smoke group count from profile or validated override", () => {
    expect(
      resolveRouteSmokeGroupCount(
        E2E_EXECUTION_PROFILE.networkBaseline,
        undefined,
      ),
    ).toBe(1);
    expect(
      resolveRouteSmokeGroupCount(E2E_EXECUTION_PROFILE.networkBaseline, ""),
    ).toBe(1);
    expect(
      resolveRouteSmokeGroupCount(E2E_EXECUTION_PROFILE.networkBaseline, "2"),
    ).toBe(2);
    for (const invalid of ["0", "-1", "1.5", "two"]) {
      expect(() =>
        resolveRouteSmokeGroupCount(
          E2E_EXECUTION_PROFILE.networkBaseline,
          invalid,
        ),
      ).toThrow(`Invalid E2E_ROUTE_SMOKE_GROUPS: ${invalid}`);
    }
  });
});
