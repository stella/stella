import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  BROWSER_SITE_NOTE_REFUSAL_CODE,
  BROWSER_SITE_NOTE_TEXT_CHARS,
  browserSiteNoteContentRefusal,
  saveBrowserSiteNotesInputSchema,
} from "./browser-site-notes";

const refusalOf = (text: string) => browserSiteNoteContentRefusal(text)?.code;

describe("site note content", () => {
  test("keeps notes about how a website works", () => {
    for (const text of [
      "Type the docket number into the second field; the first one only searches party names.",
      "The date filter takes DD.MM.YYYY; 1.1.2020 31.12.2020 works, an ISO date returns nothing.",
      "Open /search/advanced, not the quick search box: only the advanced form filters by court.",
      "Results load 20 per page; use the Next link, the page number box ignores input.",
      "Clicking Export opens a sign-in prompt: ask the member to sign in, then retry.",
      "Search for Pl. ÚS 19/08 style dockets with the space kept.",
      "The full-text toggle sits under the results-table-row-2024 header.",
    ]) {
      expect(browserSiteNoteContentRefusal(text)).toBeNull();
    }
  });

  test("refuses e-mail addresses", () => {
    expect(refusalOf("Support answers at helpdesk@example.com")).toBe(
      BROWSER_SITE_NOTE_REFUSAL_CODE.email,
    );
  });

  test("refuses addresses with a query string, and keeps a bare path", () => {
    expect(
      refusalOf("Go to https://example.com/search?q=smith&court=2 directly"),
    ).toBe(BROWSER_SITE_NOTE_REFUSAL_CODE.urlQuery);
    expect(refusalOf("www.example.com/find?term=x works")).toBe(
      BROWSER_SITE_NOTE_REFUSAL_CODE.urlQuery,
    );
    expect(refusalOf("https://example.com/search/advanced is the form")).toBe(
      undefined,
    );
  });

  test("refuses things shaped like credentials", () => {
    for (const text of [
      "password: hunter2",
      "heslo=tajne123",
      "api key: abc",
      // Each shape is assembled here so the fixture is never a literal key.
      `use ${["sk", "proj", "x".repeat(20)].join("-")}`,
      `${["gh", "p_"].join("")}${"y".repeat(30)}`,
      `${["AK", "IA"].join("")}${"Q".repeat(16)}`,
      `token ${["ey", "J"].join("")}${"z".repeat(10)}.${"w".repeat(10)}.sig`,
      `session ${"a1".repeat(14)}`,
      `cookie ${"Ab3dE_f9Hi-".repeat(3)}`,
    ]) {
      expect(refusalOf(text)).toBe(BROWSER_SITE_NOTE_REFUSAL_CODE.secret);
    }
  });

  test("refuses phone, account and identity numbers", () => {
    for (const text of [
      "call +420 777 123 456 for access",
      "card 4111 1111 1111 1111",
      "client 855101/1234",
      "pay to CZ65 0800 0000 1920 0014 5399",
    ]) {
      expect(refusalOf(text)).toBe(BROWSER_SITE_NOTE_REFUSAL_CODE.personalData);
    }
  });

  test("refuses any text that carries an e-mail address, wherever it sits", () => {
    assertProperty(
      "an e-mail address anywhere in a note is refused",
      fc.property(
        fc.string({ maxLength: 60 }),
        fc.emailAddress(),
        fc.string({ maxLength: 60 }),
        (before, address, after) => {
          expect(
            browserSiteNoteContentRefusal(`${before} ${address} ${after}`),
          ).not.toBeNull();
        },
      ),
    );
  });

  test("refuses any address that carries a query string", () => {
    assertProperty(
      "a web address with a query parameter is refused",
      fc.property(
        fc.webUrl({ withQueryParameters: true }),
        fc.stringMatching(/^[a-z]{1,8}$/u),
        fc.stringMatching(/^[a-z0-9]{1,8}$/u),
        (url, key, value) => {
          const withQuery = url.includes("?")
            ? `${url}&${key}=${value}`
            : `${url}?${key}=${value}`;
          expect(
            browserSiteNoteContentRefusal(`open ${withQuery} first`),
          ).not.toBeNull();
        },
      ),
    );
  });
});

describe("site note changes", () => {
  test("a save names its changes by one discriminator", () => {
    const parsed = v.safeParse(saveBrowserSiteNotesInputSchema, {
      url: "https://example.com/search",
      changes: [
        { type: "add", kind: "works", step: "search", text: "Use the form." },
        { type: "confirm", id: "01990000-0000-7000-8000-000000000001" },
        { type: "remove", id: "01990000-0000-7000-8000-000000000002" },
        {
          type: "replace",
          id: "01990000-0000-7000-8000-000000000003",
          kind: "fixed",
          step: "filter",
          text: "The court filter moved under More.",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("refuses text longer than the cap and an unknown kind", () => {
    for (const change of [
      {
        type: "add",
        kind: "works",
        step: "search",
        text: "x".repeat(BROWSER_SITE_NOTE_TEXT_CHARS + 1),
      },
      { type: "add", kind: "maybe", step: "search", text: "Use the form." },
      { type: "confirm", id: "not-an-id" },
    ]) {
      expect(
        v.safeParse(saveBrowserSiteNotesInputSchema, {
          url: "https://example.com",
          changes: [change],
        }).success,
      ).toBe(false);
    }
  });
});
