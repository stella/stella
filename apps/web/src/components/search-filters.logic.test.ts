import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as search from "@/lib/search";

import {
  clearTime,
  resolveUpdatedFrom,
  resolveUpdatedTo,
  setCustomTime,
  setPresetTime,
  toggleArrayMember,
} from "./search-filters.logic";
import type { SearchFilters } from "./search-filters.logic";

const baseFilters = (
  overrides: Partial<SearchFilters> = {},
): SearchFilters => ({
  workspaceIds: [],
  types: [],
  editedByUserIds: [],
  mimeTypes: [],
  ...overrides,
});

afterEach(() => {
  // Restore any spy installed on the shared search module so a preset
  // test cannot leak a stubbed clock into the next test.
  spyOn(search, "presetUpdatedFrom").mockRestore();
});

describe("resolveUpdatedFrom", () => {
  test("returns no lower bound when there is no time filter", () => {
    expect(resolveUpdatedFrom(undefined)).toBeUndefined();
  });

  test("delegates a preset to presetUpdatedFrom", () => {
    const stub = spyOn(search, "presetUpdatedFrom").mockReturnValue(
      "2026-01-01T00:00:00.000Z",
    );

    expect(resolveUpdatedFrom({ mode: "preset", preset: "week" })).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(stub).toHaveBeenCalledWith("week");
  });

  test("returns the custom lower bound verbatim", () => {
    expect(
      resolveUpdatedFrom({
        mode: "custom",
        updatedFrom: "2026-03-10T00:00:00.000Z",
        updatedTo: "2026-03-20T23:59:59.999Z",
      }),
    ).toBe("2026-03-10T00:00:00.000Z");
  });

  test("returns undefined for a custom filter with only an upper bound", () => {
    expect(
      resolveUpdatedFrom({
        mode: "custom",
        updatedTo: "2026-03-20T23:59:59.999Z",
      }),
    ).toBeUndefined();
  });
});

describe("resolveUpdatedTo", () => {
  test("returns no upper bound when there is no time filter", () => {
    expect(resolveUpdatedTo(undefined)).toBeUndefined();
  });

  test("never derives an upper bound from a preset", () => {
    expect(
      resolveUpdatedTo({ mode: "preset", preset: "month" }),
    ).toBeUndefined();
  });

  test("returns the custom upper bound verbatim", () => {
    expect(
      resolveUpdatedTo({
        mode: "custom",
        updatedTo: "2026-03-20T23:59:59.999Z",
      }),
    ).toBe("2026-03-20T23:59:59.999Z");
  });

  test("returns undefined for a custom filter with only a lower bound", () => {
    expect(
      resolveUpdatedTo({
        mode: "custom",
        updatedFrom: "2026-03-10T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});

describe("clearTime", () => {
  test("removes the time key entirely rather than setting it to undefined", () => {
    const result = clearTime(
      baseFilters({ time: { mode: "preset", preset: "day" } }),
    );

    expect("time" in result).toBe(false);
  });

  test("is a no-op shape change when there is already no time filter", () => {
    const filters = baseFilters({ workspaceIds: ["w1"], types: ["document"] });

    expect(clearTime(filters)).toEqual(filters);
  });

  test("preserves every non-time filter field", () => {
    const result = clearTime(
      baseFilters({
        workspaceIds: ["w1", "w2"],
        types: ["matter", "document"],
        editedByUserIds: ["u1"],
        mimeTypes: ["application/pdf"],
        time: { mode: "custom", updatedFrom: "2026-03-10T00:00:00.000Z" },
      }),
    );

    expect(result).toEqual(
      baseFilters({
        workspaceIds: ["w1", "w2"],
        types: ["matter", "document"],
        editedByUserIds: ["u1"],
        mimeTypes: ["application/pdf"],
      }),
    );
  });
});

describe("setPresetTime", () => {
  test("clears the time filter when the preset is undefined (toggle-off)", () => {
    const result = setPresetTime(
      baseFilters({ time: { mode: "preset", preset: "week" } }),
      undefined,
    );

    expect("time" in result).toBe(false);
  });

  test("clearing via setPresetTime matches clearTime exactly", () => {
    const filters = baseFilters({
      workspaceIds: ["w1"],
      time: { mode: "custom", updatedTo: "2026-03-20T23:59:59.999Z" },
    });

    expect(setPresetTime(filters, undefined)).toEqual(clearTime(filters));
  });

  test("replaces any existing time filter with the new preset", () => {
    const result = setPresetTime(
      baseFilters({
        time: { mode: "custom", updatedFrom: "2026-03-10T00:00:00.000Z" },
      }),
      "year",
    );

    expect(result.time).toEqual({ mode: "preset", preset: "year" });
  });
});

describe("setCustomTime", () => {
  test("omits an absent lower bound rather than writing undefined", () => {
    const result = setCustomTime(baseFilters(), {
      updatedTo: "2026-03-20T23:59:59.999Z",
    });

    expect(result.time).toEqual({
      mode: "custom",
      updatedTo: "2026-03-20T23:59:59.999Z",
    });
    expect(result.time && "updatedFrom" in result.time).toBe(false);
  });

  test("omits an absent upper bound rather than writing undefined", () => {
    const result = setCustomTime(baseFilters(), {
      updatedFrom: "2026-03-10T00:00:00.000Z",
    });

    expect(result.time).toEqual({
      mode: "custom",
      updatedFrom: "2026-03-10T00:00:00.000Z",
    });
    expect(result.time && "updatedTo" in result.time).toBe(false);
  });

  test("an empty range produces a bare custom filter (custom toggle-on)", () => {
    expect(setCustomTime(baseFilters(), {}).time).toEqual({ mode: "custom" });
  });

  test("replaces a preset filter with the custom range", () => {
    const result = setCustomTime(
      baseFilters({ time: { mode: "preset", preset: "day" } }),
      {
        updatedFrom: "2026-03-10T00:00:00.000Z",
        updatedTo: "2026-03-20T23:59:59.999Z",
      },
    );

    expect(result.time).toEqual({
      mode: "custom",
      updatedFrom: "2026-03-10T00:00:00.000Z",
      updatedTo: "2026-03-20T23:59:59.999Z",
    });
  });
});

describe("toggleArrayMember", () => {
  test("adds a value that is not present", () => {
    expect(toggleArrayMember(["a"], "b")).toEqual(["a", "b"]);
  });

  test("removes a value that is present", () => {
    expect(toggleArrayMember(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  test("does not mutate the input array", () => {
    const input = ["a", "b"];
    toggleArrayMember(input, "c");
    expect(input).toEqual(["a", "b"]);
  });

  test("removes only the first/all equal entries via filter semantics", () => {
    expect(toggleArrayMember(["a", "a"], "a")).toEqual([]);
  });
});
