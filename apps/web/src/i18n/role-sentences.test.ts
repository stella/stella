import {
  isLiteralElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  parse,
} from "@formatjs/icu-messageformat-parser";
import type {
  MessageFormatElement,
  SelectElement,
} from "@formatjs/icu-messageformat-parser";
import { describe, expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { UI_LOCALES } from "@stll/locales";

// A role named inside a sentence is inflected in many languages ("z člena na
// administrátora", "tagról adminisztrátorra"), so a sentence never takes a
// translated role label as an argument: it selects on the role code and each
// locale words every role itself.

type RoleSelect = { key: string; argument: string; select: SelectElement };

const ROLE_NAMES: ReadonlySet<string> = new Set(ORGANIZATION_ROLE_NAMES);

const readCatalog = async (locale: string): Promise<unknown> =>
  await Bun.file(new URL(`langs/${locale}.json`, import.meta.url)).json();

const flattenMessages = (
  catalog: unknown,
  prefix = "",
): { key: string; value: string }[] =>
  typeof catalog === "object" && catalog !== null
    ? Object.entries(catalog).flatMap(([name, value]) => {
        const key = prefix === "" ? name : `${prefix}.${name}`;
        return typeof value === "string"
          ? [{ key, value }]
          : flattenMessages(value, key);
      })
    : [];

const selectsIn = (
  elements: readonly MessageFormatElement[],
): SelectElement[] =>
  elements.flatMap((element) => {
    if (isSelectElement(element)) {
      return [
        element,
        ...Object.values(element.options).flatMap(({ value }) =>
          selectsIn(value),
        ),
      ];
    }
    if (isPluralElement(element)) {
      return Object.values(element.options).flatMap(({ value }) =>
        selectsIn(value),
      );
    }
    return isTagElement(element) ? selectsIn(element.children) : [];
  });

/** Every select over organization roles in a catalog, by message and argument. */
const roleSelectsOf = (catalog: unknown): RoleSelect[] =>
  flattenMessages(catalog).flatMap(({ key, value }) =>
    selectsIn(parse(value))
      .filter((select) =>
        Object.keys(select.options).some((option) => ROLE_NAMES.has(option)),
      )
      .map((select) => ({ key, argument: select.value, select })),
  );

const locationOf = ({ key, argument }: RoleSelect) => `${key} {${argument}}`;

const literalText = (elements: readonly MessageFormatElement[]) =>
  elements
    .map((element) => (isLiteralElement(element) ? element.value : ""))
    .join("");

const sourceRoleSelects = roleSelectsOf(await readCatalog("en"));

describe("role inside a sentence", () => {
  test("the source catalog names roles in sentences through a select", () => {
    expect(sourceRoleSelects.map(locationOf)).toEqual(
      expect.arrayContaining([
        "auth.invitation.description {role}",
        "organization.members.confirmRoleChangeDescription {oldRole}",
        "organization.members.confirmRoleChangeDescription {newRole}",
      ]),
    );
  });

  test.each(UI_LOCALES)(
    "%s words every organization role wherever a sentence names one",
    async (locale) => {
      const roleSelects = roleSelectsOf(await readCatalog(locale));

      expect(roleSelects.map(locationOf).toSorted()).toEqual(
        sourceRoleSelects.map(locationOf).toSorted(),
      );
      for (const { select } of roleSelects) {
        expect(Object.keys(select.options).toSorted()).toEqual(
          [...ORGANIZATION_ROLE_NAMES, "other"].toSorted(),
        );
        const wordings = ORGANIZATION_ROLE_NAMES.map((role) =>
          literalText(select.options[role]?.value ?? []).trim(),
        );
        expect(wordings.every((wording) => wording !== "")).toBe(true);
        expect(new Set(wordings).size).toBe(ORGANIZATION_ROLE_NAMES.length);
        // Callers pass a typed role, so `other` never prints anything.
        expect(select.options["other"]?.value).toEqual([]);
      }
    },
  );
});
