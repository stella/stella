import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import nodePath from "node:path";
import { createTranslator } from "use-intl/core";

import { CASE_LAW_ANALYSIS_UNAVAILABLE_CODES } from "@stll/api-contract";
import { ANALYSIS_FAILURE_CODES } from "@stll/legal-ast/analysis";

import { PROVIDER_KEYS } from "@/components/ai-config-role-models.logic";
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
  ANALYSIS_KEYED_FAILURE_MESSAGE,
  analysisErrorMessage,
  providerLabel,
} from "./analysis-error.logic";

const LANGS_DIR = nodePath.resolve(
  import.meta.dir,
  "../../../../../i18n/langs",
);

// Every catalog the app ships, so a locale whose sentence forgets the key
// distinction fails here rather than reading as the platform's fault.
// Typed as the source catalog: every locale carries its keys, so a locale
// that lost one fails to compile here too.
const catalogs: readonly { locale: string; messages: typeof en }[] = [
  { locale: "ar", messages: ar },
  { locale: "cs", messages: cs },
  { locale: "de", messages: de },
  { locale: "en", messages: en },
  { locale: "es", messages: es },
  { locale: "et", messages: et },
  { locale: "fr", messages: fr },
  { locale: "hu", messages: hu },
  { locale: "lt", messages: lt },
  { locale: "lv", messages: lv },
  { locale: "pl", messages: pl },
  { locale: "pt-BR", messages: ptBR },
  { locale: "sk", messages: sk },
];

const keyedCodes = ANALYSIS_FAILURE_CODES.filter((code) => code !== "failed");

describe("analysis error messages", () => {
  test("every failed-run code but the generic one names whose key the run used", () => {
    expect(Object.keys(ANALYSIS_KEYED_FAILURE_MESSAGE).toSorted()).toEqual(
      [...keyedCodes].toSorted(),
    );
  });

  test("the catalogs under test are exactly the shipped ones", () => {
    const shipped = readdirSync(LANGS_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/u, ""))
      .toSorted();
    expect(catalogs.map(({ locale }) => locale).toSorted()).toEqual(shipped);
  });

  for (const { locale, messages } of catalogs) {
    test(`an organization's own key and the platform's read differently in ${locale}`, () => {
      const t = createTranslator({ locale, messages });
      for (const code of keyedCodes) {
        const own = analysisErrorMessage({
          kind: "failed",
          code,
          key: { source: "organization", provider: "google" },
        });
        const platform = analysisErrorMessage({
          kind: "failed",
          code,
          key: { source: "platform" },
        });
        if (own.kind !== "keyed" || platform.kind !== "keyed") {
          throw new Error(`expected keyed messages for ${code}`);
        }
        const ownText = t(own.key, own.values);
        const platformText = t(platform.key, platform.values);
        expect(ownText).toContain("Google");
        expect(platformText).not.toContain("Google");
        expect(platformText).not.toBe(ownText);
      }
    });
  }

  test("an incomplete answer on an organization's Google key says so", () => {
    const message = analysisErrorMessage({
      kind: "failed",
      code: "answer_incomplete",
      key: { source: "organization", provider: "google" },
    });
    if (message.kind !== "keyed") {
      throw new Error("expected a keyed message");
    }
    const t = createTranslator({ locale: "en", messages: en });
    expect(t(message.key, message.values)).toBe(
      "Your organization's Google key returned an incomplete answer.",
    );
  });

  test("a generic failure and an unreadable answer use the generic message", () => {
    expect(
      analysisErrorMessage({
        kind: "failed",
        code: "failed",
        key: { source: "platform" },
      }),
    ).toEqual({ kind: "generic" });
    expect(analysisErrorMessage({ kind: "unreadable" })).toEqual({
      kind: "generic",
    });
  });

  test("a decision the server will never analyse says it is unavailable", () => {
    for (const code of CASE_LAW_ANALYSIS_UNAVAILABLE_CODES) {
      expect(analysisErrorMessage({ kind: "unavailable", code })).toEqual({
        kind: "unavailable",
      });
    }
  });

  test("a provider is named as organization settings name it, and an unknown one as given", () => {
    for (const provider of PROVIDER_KEYS) {
      expect(providerLabel(provider)).not.toBe(provider);
    }
    expect(providerLabel("google")).toBe("Google");
    expect(providerLabel("some-gateway")).toBe("some-gateway");
  });
});
