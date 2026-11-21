import { expect, test } from "bun:test";

import { resolveAIProviderSettings } from "@stll/api-contract/organization-ai-availability";

test.each(["allowed", "permission_required", "account_restricted"] as const)(
  "provider resolution covers every read outcome for %s",
  (providerConfiguration) => {
    expect(
      resolveAIProviderSettings({
        orgConfigured: true,
        providerConfiguration,
        readStatus: "ready",
      }),
    ).toEqual({ type: "orgSettings" });
    expect(
      resolveAIProviderSettings({
        orgConfigured: false,
        providerConfiguration,
        readStatus: "ready",
      }),
    ).toEqual({
      type: "defaultProvider",
      reason:
        providerConfiguration === "allowed" ? "notConfigured" : "notPermitted",
    });
    for (const orgConfigured of [false, true]) {
      expect(
        resolveAIProviderSettings({
          orgConfigured,
          providerConfiguration,
          readStatus: "unavailable",
        }),
      ).toEqual({ type: "unavailable", reason: "settingsUnreadable" });
    }
  },
);
