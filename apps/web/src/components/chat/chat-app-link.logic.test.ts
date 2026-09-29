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
  createStatuteDayTarget,
  createStatuteLinkTab,
  statuteLinkOpening,
} from "@/components/chat/chat-app-link.logic";
import { isStatuteViewPayload } from "@/features/statutes/statute-inspector.logic";
import {
  resolveStatuteRoute,
  type StatuteRouteReads,
} from "@/features/statutes/statute-route-resolution";

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
      link: { anchor: null, asOf: null, params: statuteParams },
    });
  });

  test("a statute page's fragment is the provision it lands on", () => {
    const url = new URL(`${statutePath}#par_90-odst_5`, APP_ORIGIN);

    expect(classifyChatHttpLink(url, APP_ORIGINS)).toEqual({
      type: "statute",
      link: { anchor: "par_90-odst_5", asOf: null, params: statuteParams },
    });
  });

  test("a statute page's `?asOf` is the day the act is read on", () => {
    const url = new URL(`${statutePath}?asOf=2019-05-01`, APP_ORIGIN);

    expect(classifyChatHttpLink(url, APP_ORIGINS)).toEqual({
      type: "statute",
      link: { anchor: null, asOf: "2019-05-01", params: statuteParams },
    });
  });

  test("an `?asOf` that is not a calendar day is dropped, as the page drops it", () => {
    const url = new URL(`${statutePath}?asOf=2019-02-30`, APP_ORIGIN);

    expect(classifyChatHttpLink(url, APP_ORIGINS)).toEqual({
      type: "statute",
      link: { anchor: null, asOf: null, params: statuteParams },
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

describe("a statute link on a day the publisher's dates leave unanswered", () => {
  const WORK = {
    country: "CZE",
    eli: "/eli/cz/sb/2012/89",
    id: DOCUMENT_ID,
    slug: "89-2012-sb-obcansky-zakonik",
    title: "89/2012 Sb., občanský zákoník",
    versionValidFrom: "2024-01-01",
  };
  const GAP = [
    {
      basis: "reversed",
      id: "00000000-0000-4000-8000-000000000004",
      language: "cs",
      versionValidFrom: "2022-01-01",
      versionValidTo: "2021-12-31",
    },
  ] as const;

  /** A corpus whose every dated read lands in the gap. */
  const gapReads: StatuteRouteReads<typeof WORK> = {
    byId: async () => await Promise.resolve(WORK),
    bySlug: async (key) =>
      await Promise.resolve(key.asOf === undefined ? WORK : { windowGap: GAP }),
  };

  const openingFor = async (
    href: string,
    reads: StatuteRouteReads<typeof WORK>,
  ) => {
    const link = classifyChatHttpLink(new URL(href, APP_ORIGIN), APP_ORIGINS);
    if (link.type !== "statute") {
      return panic(`Expected a statute link, got ${link.type}`);
    }
    return statuteLinkOpening(
      await resolveStatuteRoute(
        { ...link.link.params, asOf: link.link.asOf ?? undefined },
        reads,
      ),
    );
  };

  const bareStatutePath = createStatutePath(
    createStatuteRouteParams({
      country: "cze",
      documentId: DOCUMENT_ID,
      eli: WORK.eli,
      slug: WORK.slug,
      version: null,
    }),
  );

  test.each([
    ["an `?asOf` link", `${bareStatutePath}?asOf=2022-02-01`, "2022-02-01"],
    ["a `/v/` link", statutePath, "2021-01-01"],
  ])(
    "%s opens the act's page on the requested day, not its default wording",
    async (_, href, day) => {
      const opening = await openingFor(href, gapReads);

      expect(opening).toEqual({ type: "day", asOf: day, work: WORK });
      expect(createStatuteDayTarget(WORK, day)).toEqual({
        params: { country: "cze", slug: WORK.slug },
        search: { asOf: day },
        to: "/law/$country/statutes/$slug",
      });
    },
  );

  test("a day some version answers opens that wording", async () => {
    const answered: StatuteRouteReads<typeof WORK> = {
      ...gapReads,
      bySlug: async () => await Promise.resolve(WORK),
    };

    expect(await openingFor(statutePath, answered)).toEqual({
      type: "wording",
      statute: WORK,
    });
  });
});
