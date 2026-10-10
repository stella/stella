import { expect, test } from "bun:test";

import { BYOK_DEFAULT_MODELS } from "@stll/ai-catalog";
import { UI_LOCALES } from "@stll/locales";

const messageAt = (messages: unknown, key: string): unknown => {
  let value = messages;
  for (const segment of key.split(".")) {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    value = new Map(Object.entries(value)).get(segment);
  }
  return value;
};

test.each(UI_LOCALES)(
  "%s translates every catalog default model rationale",
  async (locale) => {
    const messages: unknown = await Bun.file(
      new URL(`langs/${locale}.json`, import.meta.url),
    ).json();
    expect(
      messageAt(messages, "organization.aiConfig.roleUnavailable"),
    ).toContain("{provider}");
    for (const roles of Object.values(BYOK_DEFAULT_MODELS)) {
      for (const entry of Object.values(roles)) {
        const key =
          entry.kind === "unsupported"
            ? "organization.aiConfig.roleUnavailable"
            : entry.rationaleKey;
        const rationale = messageAt(messages, key);
        expect(rationale).toBeString();
        expect(
          typeof rationale === "string" && rationale.trim().length > 0,
        ).toBe(true);
        expect(
          typeof rationale === "string" && !/[\r\n]/u.test(rationale),
        ).toBe(true);
      }
    }
  },
);
