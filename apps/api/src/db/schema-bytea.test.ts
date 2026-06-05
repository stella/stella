import { describe, expect, test } from "bun:test";

import { organizationSettings } from "@/api/db/schema";

describe("nullable bytea columns", () => {
  test("map nullish relational values to null", () => {
    expect(
      organizationSettings.aiConfigEncrypted.mapFromDriverValue(undefined),
    ).toBeNull();
    expect(
      organizationSettings.aiConfigEncrypted.mapFromDriverValue(null),
    ).toBeNull();
    expect(
      organizationSettings.aiConfigEncrypted.mapFromJsonValue?.(undefined),
    ).toBeNull();
  });

  test("decode postgres hex strings", () => {
    expect(
      organizationSettings.aiConfigEncrypted.mapFromDriverValue("\\x0a0b"),
    ).toEqual(Buffer.from([10, 11]));
  });
});
