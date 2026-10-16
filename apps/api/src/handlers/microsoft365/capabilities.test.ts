import { expect, test } from "bun:test";

import {
  capabilityEnabled,
  delegatedScopes,
  grantedCapabilities,
} from "./capabilities";

test("incremental consent preserves read grants and requests selected capabilities", () => {
  const original = delegatedScopes(["files.read"], null);
  const upgraded = delegatedScopes(["calendar.read"], original);
  expect(grantedCapabilities(upgraded)).toEqual([
    "files.read",
    "calendar.read",
  ]);
  expect(delegatedScopes(["calendar.read"], upgraded)).toBe(upgraded);
  expect(grantedCapabilities(delegatedScopes(["calendar.read"], null))).toEqual(
    ["calendar.read"],
  );
  expect(delegatedScopes(["calendar.read"], "Files.Read.All")).toContain(
    "https://graph.microsoft.com/Files.Read.All",
  );
});

test("capabilities reflect complete grants and short Graph scope names", () => {
  expect(
    grantedCapabilities("User.Read Calendars.Read Files.Read.All"),
  ).toEqual(["calendar.read"]);
  expect(grantedCapabilities(null)).toEqual([]);
  expect(grantedCapabilities("Calendars.ReadWrite")).toEqual([]);
});

test("organization capability policy fails closed", () => {
  const policy = {
    microsoft365ConnectionEnabled: true,
    microsoft365FilesReadEnabled: true,
    microsoft365CalendarReadEnabled: false,
  };
  expect(capabilityEnabled(undefined, "calendar.read")).toBe(false);
  expect(capabilityEnabled(policy, "files.read")).toBe(true);
  expect(capabilityEnabled(policy, "calendar.read")).toBe(false);
  expect(
    capabilityEnabled(
      { ...policy, microsoft365CalendarReadEnabled: true },
      "calendar.read",
    ),
  ).toBe(true);
  expect(
    capabilityEnabled(
      { ...policy, microsoft365ConnectionEnabled: false },
      "files.read",
    ),
  ).toBe(false);
});
