/**
 * Unit tests for selective save feature flag resolution.
 */

import { describe, test, expect } from "bun:test";

import {
  DEFAULT_SELECTIVE_SAVE_MAX_BYTES,
  resolveSelectiveSaveFlags,
} from "./selectiveSaveFlags";

describe("resolveSelectiveSaveFlags", () => {
  test("defaults all flags to safe values when input is undefined", () => {
    const resolved = resolveSelectiveSaveFlags(undefined);
    expect(resolved.selectiveSave).toBe(false);
    expect(resolved.selectiveSaveTripwire).toBe(false);
    expect(resolved.selectiveSaveMaxBytes).toBe(
      DEFAULT_SELECTIVE_SAVE_MAX_BYTES,
    );
  });

  test("defaults all flags to safe values when input is an empty object", () => {
    const resolved = resolveSelectiveSaveFlags({});
    expect(resolved.selectiveSave).toBe(false);
    expect(resolved.selectiveSaveTripwire).toBe(false);
    expect(resolved.selectiveSaveMaxBytes).toBe(
      DEFAULT_SELECTIVE_SAVE_MAX_BYTES,
    );
  });

  test("honours an explicit `selectiveSave: true`", () => {
    const resolved = resolveSelectiveSaveFlags({ selectiveSave: true });
    expect(resolved.selectiveSave).toBe(true);
    expect(resolved.selectiveSaveTripwire).toBe(false);
  });

  test("tripwire is independent from selectiveSave", () => {
    const resolved = resolveSelectiveSaveFlags({
      selectiveSaveTripwire: true,
    });
    expect(resolved.selectiveSave).toBe(false);
    expect(resolved.selectiveSaveTripwire).toBe(true);
  });

  test("custom selectiveSaveMaxBytes overrides the default ceiling", () => {
    const resolved = resolveSelectiveSaveFlags({
      selectiveSaveMaxBytes: 4096,
    });
    expect(resolved.selectiveSaveMaxBytes).toBe(4096);
  });

  test("default ceiling is 100 MiB so legal docs with embedded scans fit", () => {
    expect(DEFAULT_SELECTIVE_SAVE_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});
