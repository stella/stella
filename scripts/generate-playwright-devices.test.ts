import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { devices } from "../packages/playwright-tools/src/devices";
import {
  configuredPlaywrightDevices,
  DEVICE_OUTPUT,
  renderPlaywrightDevices,
  usedPlaywrightDevices,
} from "./generate-playwright-devices";

test("configured presets match the pinned SDK and generated runtime data", async () => {
  expect(Object.keys(devices).toSorted()).toEqual(usedPlaywrightDevices());
  expect(configuredPlaywrightDevices()).toEqual(devices);
  expect(
    readFileSync(
      path.resolve(import.meta.dirname, "..", DEVICE_OUTPUT),
      "utf-8",
    ),
  ).toBe(await renderPlaywrightDevices());
});

const expectFrozenData = (value: unknown): void => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectFrozenData(child);
  }
};

test("preset data is recursively immutable and cannot acquire retry settings", () => {
  expectFrozenData(devices);
  for (const descriptor of Object.values(devices)) {
    expect(Reflect.set(descriptor, "retries", 2)).toBe(false);
    expect(Reflect.has(descriptor, "retries")).toBe(false);
  }
  expect(Reflect.set(devices, "other", {})).toBe(false);
});
