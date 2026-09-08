import { beforeAll, describe, expect, test } from "bun:test";

// The query module imports the Eden client, which reads the API URL eagerly.
beforeAll(() => {
  process.env["VITE_API_URL"] ??= "https://api.example.test";
});

const BOOLEAN_VALUES = [false, true] as const;
const INSTANCE_SOURCES = ["preserve", "explicit"] as const;
const AVAILABILITY_TRANSITIONS = BOOLEAN_VALUES.flatMap((orgConfigured) =>
  BOOLEAN_VALUES.flatMap((instanceProvisioned) =>
    BOOLEAN_VALUES.flatMap((deferredServiceTierAvailable) =>
      INSTANCE_SOURCES.map(
        (instanceSource) =>
          [
            orgConfigured,
            instanceProvisioned,
            deferredServiceTierAvailable,
            instanceSource,
          ] as const,
      ),
    ),
  ),
);

describe("cached AI availability after config mutations", () => {
  test.each(AVAILABILITY_TRANSITIONS)(
    "sets org=%p and instance=%p, preserves deferred=%p, using %s instance state",
    async (
      orgConfigured,
      instanceProvisioned,
      deferredServiceTierAvailable,
      instanceSource,
    ) => {
      const { updateCachedAIAvailability } =
        await import("./ai-config-queries");
      const currentInstanceProvisioned =
        instanceSource === "preserve"
          ? instanceProvisioned
          : !instanceProvisioned;
      const current = {
        available: !(currentInstanceProvisioned || orgConfigured),
        deferredServiceTierAvailable,
        instanceProvisioned: currentInstanceProvisioned,
        orgConfigured: !orgConfigured,
      };

      expect(
        updateCachedAIAvailability({
          current,
          ...(instanceSource === "explicit" ? { instanceProvisioned } : {}),
          orgConfigured,
        }),
      ).toEqual({
        available: instanceProvisioned || orgConfigured,
        deferredServiceTierAvailable,
        instanceProvisioned,
        orgConfigured,
      });
    },
  );

  test("does not synthesize an unfetched server answer", async () => {
    const { updateCachedAIAvailability } = await import("./ai-config-queries");

    expect(
      updateCachedAIAvailability({
        current: undefined,
        instanceProvisioned: false,
        orgConfigured: true,
      }),
    ).toBeUndefined();
  });
});
