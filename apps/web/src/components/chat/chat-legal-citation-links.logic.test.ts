import { describe, expect, test } from "bun:test";

import {
  chatCitationAsOf,
  chatCitationCountries,
  chatCitationLinkPairs,
  chatCitationTextKey,
} from "@/components/chat/chat-legal-citation-links.logic";

describe("chat citation countries", () => {
  test("practice jurisdictions come first, primary leading", () => {
    expect(
      chatCitationCountries({
        locale: "en",
        practiceJurisdictions: [
          { countryCode: "SK", isPrimary: false },
          { countryCode: "CZ", isPrimary: true },
        ],
      }),
    ).toEqual(["CZ", "SK"]);
  });

  test("without practice jurisdictions the UI language decides", () => {
    expect(
      chatCitationCountries({ locale: "cs", practiceJurisdictions: [] }),
    ).toEqual(["CZE"]);
    expect(
      chatCitationCountries({ locale: "sk-SK", practiceJurisdictions: [] }),
    ).toEqual(["SVK"]);
    expect(
      chatCitationCountries({ locale: "en", practiceJurisdictions: [] }),
    ).toEqual([]);
  });
});

describe("chat citation request", () => {
  test("the answer's own date in the reader's zone is the version date", () => {
    const now = new Date("2026-10-15T08:00:00Z");
    const asOf = (createdAt: Date | string | undefined) =>
      chatCitationAsOf({ createdAt, now, timeZone: "Europe/Prague" });
    // Past midnight in Prague, still the previous day in UTC.
    expect(asOf(new Date("2024-02-03T23:30:00Z"))).toBe("2024-02-04");
    expect(asOf("2024-02-03T10:00:00Z")).toBe("2024-02-03");
    expect(asOf(undefined)).toBe("2026-10-15");
    expect(asOf("not a date")).toBe("2026-10-15");
  });

  test("the text key changes with the text and is stable for the same text", () => {
    expect(chatCitationTextKey("§ 52 ZP")).toBe(chatCitationTextKey("§ 52 ZP"));
    expect(chatCitationTextKey("§ 52 ZP")).not.toBe(
      chatCitationTextKey("§ 53 ZP"),
    );
  });

  test("links become the words they cover, once per spelling", () => {
    const text = "Podle § 52 ZP a znovu § 52 ZP.";
    expect(
      chatCitationLinkPairs(text, [
        { start: 6, end: 13, url: "https://app.example/a" },
        { start: 22, end: 29, url: "https://app.example/a" },
      ]),
    ).toEqual([{ text: "§ 52 ZP", url: "https://app.example/a" }]);
  });
});
