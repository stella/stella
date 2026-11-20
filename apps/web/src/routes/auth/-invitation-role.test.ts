import {
  isLiteralElement,
  isSelectElement,
  parse,
} from "@formatjs/icu-messageformat-parser";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { UI_LOCALES } from "@stll/locales";

const INVITATION_DESCRIPTION_PATH = ["auth", "invitation", "description"];

const messageAt = (messages: unknown, path: readonly string[]): unknown => {
  let value = messages;
  for (const segment of path) {
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    value = new Map(Object.entries(value)).get(segment);
  }
  return value;
};

const literalText = (elements: readonly MessageFormatElement[]) =>
  elements.map((element) => (isLiteralElement(element) ? element.value : ""));

// The role sits inside the sentence, where many languages inflect it
// ("jako člena", "als Mitglied"), so each locale words every role itself.
test.each(UI_LOCALES)(
  "%s words the invitation for every organization role",
  async (locale) => {
    const messages: unknown = await Bun.file(
      new URL(`../../i18n/langs/${locale}.json`, import.meta.url),
    ).json();
    const message = messageAt(messages, INVITATION_DESCRIPTION_PATH);
    if (typeof message !== "string") {
      throw new TypeError(`${locale} has no invitation description`);
    }

    const roleSelect = parse(message)
      .filter(isSelectElement)
      .find((element) => element.value === "role");
    if (roleSelect === undefined) {
      throw new TypeError(`${locale} does not select on the role`);
    }

    expect(Object.keys(roleSelect.options).toSorted()).toEqual(
      [...ORGANIZATION_ROLE_NAMES, "other"].toSorted(),
    );
    const wordings = ORGANIZATION_ROLE_NAMES.map((role) =>
      literalText(roleSelect.options[role]?.value ?? []).join(""),
    );
    expect(wordings.every((wording) => wording.trim() !== "")).toBe(true);
    expect(new Set(wordings).size).toBe(ORGANIZATION_ROLE_NAMES.length);
    // The loader refuses an unknown role, so `other` never prints anything.
    expect(roleSelect.options["other"]?.value).toEqual([]);
  },
);
