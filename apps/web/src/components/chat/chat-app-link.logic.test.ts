import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import {
  createStatutePath,
  createStatuteRouteParams,
} from "@stll/api-contract/statute-route";

import {
  classifyChatHttpLink,
  createStatuteLinkTab,
} from "@/components/chat/chat-app-link.logic";
import { isStatuteViewPayload } from "@/features/statutes/statute-inspector.logic";

const APP_ORIGIN = "https://app.example.test";
const APP_ORIGINS = new Set([APP_ORIGIN]);
const DOCUMENT_ID = "019dd47d-f507-7c84-b827-980af11b8980";

const statuteParams = createStatuteRouteParams({
  country: "cze",
  documentId: DOCUMENT_ID,
  eli: "/eli/cz/sb/2012/89",
  slug: "89-2012-sb-obcansky-zakonik",
  version: "2021-01-01",
});
const statutePath = createStatutePath(statuteParams);

const decisionParams = createCaseLawDecisionRouteParams({
  caseNumber: "26 Cdo 4249/2016",
  country: "cze",
  court: "Nejvyšší soud",
  decisionId: DOCUMENT_ID,
  language: null,
  languageAlternates: null,
  slug: null,
});

describe("chat http links", () => {
  test("an app decision page is the decision", () => {
    const url = new URL(createCaseLawDecisionPath(decisionParams), APP_ORIGIN);

    expect(classifyChatHttpLink(url, APP_ORIGINS)).toEqual({
      type: "decision",
      params: decisionParams,
    });
  });

  test("an app statute page is the act, with no anchor when none is named", () => {
    const url = new URL(statutePath, APP_ORIGIN);

    expect(classifyChatHttpLink(url, APP_ORIGINS)).toEqual({
      type: "statute",
      link: { anchor: null, params: statuteParams },
    });
  });

  test("a statute page's fragment is the provision it lands on", () => {
    const url = new URL(`${statutePath}#par_90-odst_5`, APP_ORIGIN);

    expect(classifyChatHttpLink(url, APP_ORIGINS)).toEqual({
      type: "statute",
      link: { anchor: "par_90-odst_5", params: statuteParams },
    });
  });

  test("the same path on another origin is a web page", () => {
    const url = new URL(statutePath, "https://elsewhere.example.test");

    expect(classifyChatHttpLink(url, APP_ORIGINS)).toEqual({
      type: "external",
    });
  });

  test("an app page that is neither a decision nor a statute is a web page", () => {
    const url = new URL("/law/cze/statutes", APP_ORIGIN);

    expect(classifyChatHttpLink(url, APP_ORIGINS)).toEqual({
      type: "external",
    });
  });
});

describe("the tab a statute link opens", () => {
  const statute = {
    country: "CZE",
    eli: "/eli/cz/sb/2012/89",
    id: DOCUMENT_ID,
    slug: "89-2012-sb-obcansky-zakonik",
    title: "89/2012 Sb., občanský zákoník",
    versionValidFrom: "2021-01-01",
  };

  const statuteLinkAt = (href: string) => {
    const link = classifyChatHttpLink(new URL(href, APP_ORIGIN), APP_ORIGINS);
    if (link.type !== "statute") {
      return panic(`Expected a statute link, got ${link.type}`);
    }
    return link.link;
  };

  test("lands on the provision the link's fragment names", () => {
    const tab = createStatuteLinkTab(
      statute,
      statuteLinkAt(`${statutePath}#par_90-odst_5`),
    );

    expect(tab.payload.anchorId).toBe("par_90-odst_5");
    expect(tab.payload.documentId).toBe(DOCUMENT_ID);
    expect(isStatuteViewPayload(tab.payload)).toBe(true);
  });

  test("opens the act whole when the link names no provision", () => {
    const tab = createStatuteLinkTab(statute, statuteLinkAt(statutePath));

    expect("anchorId" in tab.payload).toBe(false);
    expect(isStatuteViewPayload(tab.payload)).toBe(true);
  });
});
