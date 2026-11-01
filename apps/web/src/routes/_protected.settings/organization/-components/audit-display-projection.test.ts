import { expect, test } from "bun:test";

import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@stll/api-contract/audit-log";

import ar from "@/i18n/langs/ar.json";
import cs from "@/i18n/langs/cs.json";
import de from "@/i18n/langs/de.json";
import en from "@/i18n/langs/en.json";
import es from "@/i18n/langs/es.json";
import et from "@/i18n/langs/et.json";
import fr from "@/i18n/langs/fr.json";
import hu from "@/i18n/langs/hu.json";
import lt from "@/i18n/langs/lt.json";
import lv from "@/i18n/langs/lv.json";
import pl from "@/i18n/langs/pl.json";
import ptBR from "@/i18n/langs/pt-BR.json";
import sk from "@/i18n/langs/sk.json";

import {
  AUDIT_ACTION_PROJECTIONS,
  AUDIT_RESOURCE_PROJECTIONS,
  projectAuditResourceLabel,
} from "./audit-display-projection";

const auditResourceKindsByLocale = {
  ar: ar.settings.organization.auditResourceKinds,
  cs: cs.settings.organization.auditResourceKinds,
  de: de.settings.organization.auditResourceKinds,
  en: en.settings.organization.auditResourceKinds,
  es: es.settings.organization.auditResourceKinds,
  et: et.settings.organization.auditResourceKinds,
  fr: fr.settings.organization.auditResourceKinds,
  hu: hu.settings.organization.auditResourceKinds,
  lt: lt.settings.organization.auditResourceKinds,
  lv: lv.settings.organization.auditResourceKinds,
  pl: pl.settings.organization.auditResourceKinds,
  "pt-BR": ptBR.settings.organization.auditResourceKinds,
  sk: sk.settings.organization.auditResourceKinds,
} as const;

const unknownItemPrefixes =
  /^(?:unknown item|عنصر غير معروف|neznámá položka|unbekanntes Element|elemento desconocido|tundmatu üksus|élément inconnu|ismeretlen elem|nežinomas elementas|nezināms vienums|nieznany element|item desconhecido|neznáma položka)(?::|$)/iu;

// Product terms the glossary (apps/web/src/i18n/TERMINOLOGY.md) keeps
// untranslated, so a locale may legitimately show the English word.
const GLOSSARY_KEEPS_ENGLISH: ReadonlySet<string> = new Set(["playbook"]);

test("audit resource kind labels remain natural localized phrases", () => {
  const englishKinds = auditResourceKindsByLocale.en;
  const englishKeys = Object.keys(englishKinds).toSorted();
  const englishValueByKey = new Map(Object.entries(englishKinds));

  for (const [locale, kinds] of Object.entries(auditResourceKindsByLocale)) {
    expect(Object.keys(kinds).toSorted(), `${locale} key set`).toEqual(
      englishKeys,
    );

    for (const [key, value] of Object.entries(kinds)) {
      const matchesSource =
        locale !== "en" &&
        !GLOSSARY_KEEPS_ENGLISH.has(key) &&
        (value === key || value === englishValueByKey.get(key));
      expect(
        matchesSource,
        `${locale}:${key} must differ from its key and English label`,
      ).toBe(false);
      expect(
        value,
        `${locale}:${key} must not contain an underscore`,
      ).not.toContain("_");
      expect(
        value,
        `${locale}:${key} must not use an unknown-item placeholder`,
      ).not.toMatch(unknownItemPrefixes);

      const words = [
        ...value.toLocaleLowerCase(locale).matchAll(/\p{L}+/gu),
      ].map(([word]) => word);
      expect(
        new Set(words).size,
        `${locale}:${key} must not repeat a word`,
      ).toBe(words.length);
    }
  }
});

test("every audit action and resource kind has a display projection", () => {
  expect(Object.keys(AUDIT_ACTION_PROJECTIONS).toSorted()).toEqual(
    Object.values(AUDIT_ACTION).toSorted(),
  );
  expect(Object.keys(AUDIT_RESOURCE_PROJECTIONS).toSorted()).toEqual(
    Object.values(AUDIT_RESOURCE_TYPE).toSorted(),
  );
});

test("status-only matter rows retain their distinct current names", () => {
  const labels = ["Northwind acquisition", "Contoso dispute"].map((name) =>
    projectAuditResourceLabel({
      action: AUDIT_ACTION.UPDATE,
      resource: { kind: AUDIT_RESOURCE_TYPE.WORKSPACE, name },
      deletedLabel: (kind) => `deleted ${kind}`,
      kind: "matter",
      unavailableLabel: (kind) => `${kind} (not available)`,
    }),
  );
  expect(labels).toEqual(["Northwind acquisition", "Contoso dispute"]);
});

test("Czech and German catalogues render translated resource kinds", () => {
  const cases = [
    [cs, "položka (není k dispozici)"],
    [de, "Element (nicht verfügbar)"],
  ] as const;
  for (const [catalogue, expected] of cases) {
    const messages = catalogue.settings.organization;
    const label = projectAuditResourceLabel({
      action: AUDIT_ACTION.UPDATE,
      resource: { kind: AUDIT_RESOURCE_TYPE.ENTITY, name: null },
      deletedLabel: (value) =>
        messages.auditLogsDeletedResource.replace("{kind}", () => value),
      kind: messages.auditResourceKinds.entity,
      unavailableLabel: (value) =>
        messages.auditLogsUnavailableResource.replace("{kind}", () => value),
    });
    expect(label).toBe(expected);
  }
});

test("status-only contact and invoice rows retain their names", () => {
  for (const [kind, name] of [
    [AUDIT_RESOURCE_TYPE.CONTACT, "Ada Lovelace"],
    [AUDIT_RESOURCE_TYPE.INVOICE, "2026-0042"],
  ] as const) {
    expect(
      projectAuditResourceLabel({
        action: AUDIT_ACTION.UPDATE,
        resource: { kind, name },
        deletedLabel: (value) => `deleted ${value}`,
        kind,
        unavailableLabel: (value) => `${value} unavailable`,
      }),
    ).toBe(name);
  }
});
