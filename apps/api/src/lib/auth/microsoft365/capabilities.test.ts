import { expect, test } from "bun:test";

import {
  boundGrantedScope,
  capabilityEnabled,
  consentedScopes,
  delegatedReadScopes,
  delegatedScopes,
  grantedCapabilities,
} from "@/api/lib/auth/microsoft365/capabilities";

test("calendar consent requests only the selected read capability", () => {
  expect(delegatedReadScopes(["calendar.read"])).toBe(
    "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read",
  );
  expect(delegatedReadScopes(["files.read", "calendar.read"])).toBe(
    "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Sites.Read.All https://graph.microsoft.com/Calendars.Read",
  );
});

test("scope normalization requires every scope of a capability", () => {
  expect(grantedCapabilities("calendars.read sites.read.all")).toEqual([
    "calendar.read",
  ]);
  expect(
    grantedCapabilities(
      "https://graph.microsoft.com/Sites.Read.All files.read.all CALENDARS.READ Mail.Send",
    ),
  ).toEqual(["files.read", "calendar.read"]);
});

test("selective calendar policy cannot request or retain disabled file and write grants", () => {
  const policy = {
    sharepointConnectionEnabled: false,
    microsoft365CalendarReadEnabled: true,
  };
  expect(capabilityEnabled(policy, "files.read")).toBe(false);
  expect(capabilityEnabled(policy, "calendar.read")).toBe(true);
  expect(
    delegatedScopes({
      requested: ["calendar.read"],
      grantedScope: "Files.Read.All Sites.Read.All Calendars.Read Mail.Send",
      policy,
    }),
  ).toBe(
    "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read",
  );
});

test("provider grants stay below the pending request and current policy", () => {
  const requestedScope = delegatedReadScopes(["files.read", "calendar.read"]);
  const provider = "Calendars.Read Files.Read.All Sites.Read.All Mail.Send";
  const policy = {
    sharepointConnectionEnabled: false,
    microsoft365CalendarReadEnabled: true,
  };
  expect(
    grantedCapabilities(
      consentedScopes({ providerScope: provider, requestedScope, policy }),
    ),
  ).toEqual(["calendar.read"]);
  expect(
    boundGrantedScope({
      ceiling: delegatedReadScopes(["files.read"]),
      returned: provider,
    }),
  ).toBe("Files.Read.All Sites.Read.All");
  expect(
    grantedCapabilities(
      consentedScopes({
        providerScope: "Sites.Read.All",
        requestedScope: delegatedReadScopes(["files.read"]),
        policy: {
          sharepointConnectionEnabled: true,
          microsoft365CalendarReadEnabled: true,
        },
      }),
    ),
  ).toEqual([]);
});

test("an omitted provider scope inherits only this exchange's requested read scopes", () => {
  const requestedScope = delegatedReadScopes(["calendar.read"]);
  expect(
    consentedScopes({
      providerScope: undefined,
      requestedScope,
      policy: {
        sharepointConnectionEnabled: true,
        microsoft365CalendarReadEnabled: true,
      },
    }),
  ).toBe(requestedScope);
});

test("absent policy never enables or retains a delegated read capability", () => {
  const requestedScope = delegatedReadScopes(["files.read", "calendar.read"]);
  for (const policy of [null, undefined]) {
    expect(capabilityEnabled(policy, "files.read")).toBe(false);
    expect(capabilityEnabled(policy, "calendar.read")).toBe(false);
    expect(
      grantedCapabilities(
        consentedScopes({
          policy,
          providerScope: requestedScope,
          requestedScope,
        }),
      ),
    ).toEqual([]);
  }
});
