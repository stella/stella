import { describe, expect, test } from "bun:test";

import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import {
  mintRunOutputKey,
  openRunOutputKey,
  sealRunOutputKey,
} from "./output-keys";

describe("a run's output key", () => {
  test("is 32 random bytes in hex, different for every run", () => {
    const keys = Array.from({ length: 64 }, mintRunOutputKey);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("is stored encrypted and opens only for its organization", async () => {
    const organizationId = mintAuthProviderId<"organization">();
    const outputKey = mintRunOutputKey();
    const sealed = await sealRunOutputKey(organizationId, outputKey);
    expect(sealed.ciphertext.toString("utf-8")).not.toContain(outputKey);
    expect(sealed.ciphertext.toString("hex")).not.toContain(outputKey);
    expect(await openRunOutputKey(organizationId, sealed)).toEqual({
      type: "opened",
      outputKey,
    });
    expect(
      await openRunOutputKey(mintAuthProviderId<"organization">(), sealed),
    ).toEqual({ type: "unreadable" });
  });

  test("a run that keeps none, or a sealed value that is not a key, does not open", async () => {
    const organizationId = mintAuthProviderId<"organization">();
    expect(await openRunOutputKey(organizationId, null)).toEqual({
      type: "unreadable",
    });
    const notAKey = await sealRunOutputKey(organizationId, "not a key");
    expect(await openRunOutputKey(organizationId, notAKey)).toEqual({
      type: "unreadable",
    });
  });
});
