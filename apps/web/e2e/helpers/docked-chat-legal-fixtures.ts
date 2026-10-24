import { expect, type Page } from "@playwright/test";
import { panic } from "better-result";

import {
  type CaseLawDecisionRouteInput,
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import {
  createStatutePath,
  createStatuteRouteParams,
} from "@stll/api-contract/statute-route";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { E2E_API_ORIGIN } from "./api";
import { dockedChatLegalPayloads } from "./docked-chat-legal-payloads";

const {
  decision,
  bilingualDecision,
  bilingualCzechDecision,
  statute,
  olderStatute,
  noProvisions,
  noCitations,
  noLeadingCitations,
  citationSummary,
  versions,
} = dockedChatLegalPayloads;

type DecisionFixtureIdentity = Omit<CaseLawDecisionRouteInput, "decisionId"> & {
  id: string;
};
const decisionParams = (value: DecisionFixtureIdentity) =>
  createCaseLawDecisionRouteParams({
    caseNumber: value.caseNumber,
    country: value.country,
    court: value.court,
    decisionId: value.id,
    language: value.language,
    languageAlternates: value.languageAlternates,
    slug: value.slug,
  });
const statuteParams = createStatuteRouteParams({
  country: statute.country,
  documentId: statute.id,
  eli: statute.eli,
  slug: statute.slug,
  version: null,
});
const statuteVersionParams = createStatuteRouteParams({
  country: olderStatute.country,
  documentId: olderStatute.id,
  eli: olderStatute.eli,
  slug: olderStatute.slug,
  version: olderStatute.versionValidFrom,
});

export const DOCKED_CHAT_LEGAL_ROUTES = {
  decision: {
    params: decisionParams(decision),
    path: createCaseLawDecisionPath(decisionParams(decision)),
    id: decision.id,
  },
  bilingualDecision: {
    params: decisionParams(bilingualDecision),
    path: createCaseLawDecisionPath(decisionParams(bilingualDecision)),
    id: bilingualDecision.id,
  },
  statute: {
    params: statuteParams,
    path: createStatutePath(statuteParams),
    id: statute.id,
  },
  statuteVersion: {
    params: statuteVersionParams,
    path: createStatutePath(statuteVersionParams),
    id: olderStatute.id,
  },
};

/** Resolve each host template through the same canonical route owners as the readers. */
export const dockedLegalPath = (template: string): string => {
  if (template.includes("/cases/") && template.includes("$slug")) {
    const params = template.includes("$language")
      ? DOCKED_CHAT_LEGAL_ROUTES.bilingualDecision.params
      : DOCKED_CHAT_LEGAL_ROUTES.decision.params;
    return template.replaceAll(/\$([A-Za-z]+)/gu, (_, parameter: string) => {
      switch (parameter) {
        case "country":
          return params.country;
        case "court":
          return params.court;
        case "language":
          return (
            params.language ?? panic(`No fixture language for ${template}`)
          );
        case "slug":
          return params.slug;
        default:
          return panic(
            `Unknown docked legal route parameter ${parameter} (${template})`,
          );
      }
    });
  }
  const params = template.includes("$version")
    ? statuteVersionParams
    : statuteParams;
  return template.replaceAll(/\$([A-Za-z]+)/gu, (_, parameter: string) => {
    switch (parameter) {
      case "country":
        return params.country;
      case "slug":
        return params.slug;
      case "version":
        return (
          statuteVersionParams.version ??
          panic("Missing statute fixture version")
        );
      case "tableId":
        return "019a0000-0000-7000-8000-000000000106";
      default:
        return panic(
          `Unknown docked legal route parameter ${parameter} (${template})`,
        );
    }
  });
};

/** Exact HTTP reads only: the real route, reader, runtime and composer mount. */
export const installDockedLegalFixtures = async (page: Page) => {
  const reads = [
    { pathname: `/v1/law/statutes/${statute.id}`, body: statute },
    { pathname: `/v1/law/statutes/by-slug/${statute.slug}`, body: statute },
    { pathname: `/v1/law/statutes/${statute.id}/versions`, body: versions },
    { pathname: `/v1/law/statutes/${olderStatute.id}`, body: olderStatute },
    {
      pathname: `/v1/law/statutes/${olderStatute.id}/versions`,
      body: versions,
    },
    ...[decision, bilingualDecision, bilingualCzechDecision].flatMap(
      (value) => [
        { pathname: `/v1/case/decisions/${value.id}`, body: value },
        {
          pathname: `/v1/case/decisions/${value.id}/provisions`,
          body: noProvisions,
        },
        {
          pathname: `/v1/case/decisions/${value.id}/citations`,
          body: noCitations,
        },
        {
          pathname: `/v1/case/decisions/${value.id}/citations/leading`,
          body: noLeadingCitations,
        },
        {
          pathname: `/v1/case/decisions/${value.id}/citations/summary`,
          body: citationSummary,
        },
      ],
    ),
    { pathname: `/v1/case/decisions/by-slug/${decision.slug}`, body: decision },
    {
      pathname: `/v1/case/decisions/by-slug/${bilingualDecision.slug}`,
      body: bilingualDecision,
    },
  ];
  await page.route(
    (url) =>
      url.origin === E2E_API_ORIGIN &&
      reads.some(({ pathname }) => pathname === url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const url = new URL(route.request().url());
      const read =
        reads.find(({ pathname }) => pathname === url.pathname) ??
        panic(`Unregistered legal fixture read ${url.pathname}`);
      const body = (() => {
        if (
          url.pathname ===
            `/v1/case/decisions/by-slug/${bilingualDecision.slug}` &&
          url.searchParams.get("language") === "cs"
        ) {
          return bilingualCzechDecision;
        }
        if (
          url.pathname === `/v1/law/statutes/by-slug/${statute.slug}` &&
          url.searchParams.get("asOf") === olderStatute.versionValidFrom
        ) {
          return olderStatute;
        }
        return read.body;
      })();
      await route.fulfill({ json: body });
    },
  );
};

/** Opens the reader's seeded conversation through the English chat rail. */
export const openFreshDecisionReaderChat = async (page: Page) => {
  await installDockedLegalFixtures(page);
  await page.route("**/v1/chat/threads/*/suggested-prompts*", async (route) => {
    await route.fulfill({ json: { prompts: [] } });
  });
  await page.goto("/law", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !history.pushState.toString().includes("[native code]"),
  );
  await page.evaluate((target) => {
    history.pushState(null, "", target);
  }, DOCKED_CHAT_LEGAL_ROUTES.decision.path);
  await expect(page.locator(".reader-scroll article")).toBeVisible();
  // A fresh reader keeps the inspector collapsed; activate its existing chat
  // tab rather than the footer action that can create another conversation.
  await page
    .getByRole("button", { name: messages.chat.newChat, exact: true })
    .and(page.locator('[data-slot="inspector-rail-tab"]'))
    .click();
  const composer = page.locator('[data-slot="docked-chat-composer"]');
  await expect(composer.getByRole("textbox")).toBeVisible();
  return composer;
};
