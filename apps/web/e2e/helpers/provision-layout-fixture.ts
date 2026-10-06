import type { Page } from "@playwright/test";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { api } from "../../src/lib/api";
import type { PublicLawData } from "../../src/lib/public-law-api";
import { E2E_API_ORIGIN } from "./api";
import { dockedChatLegalPayloads } from "./docked-chat-legal-payloads";

export const PROVISION_LAYOUT_SENTENCE =
  "Škůdce nahradí škodu způsobenou porušením povinnosti stanovené zákonem.";
export const CURRENT_PROVISION_SENTENCE =
  "Aktuální syntetické znění ustanovení stanoví odlišnou povinnost náhrady škody.";
const makeAst = (documentId: string, text: string, statute: boolean) =>
  ({
    version: 1,
    source: { system: "synthetic", documentId, webUrl: "", printUrl: "" },
    metadata: {
      caseNumber: null,
      ecli: null,
      court: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      ...(statute
        ? [
            {
              type: "heading" as const,
              id: "heading-2895",
              anchorId: "par_2895",
              level: 2 as const,
              inlines: [{ type: "text" as const, text: "§ 2895" }],
              plainText: "§ 2895",
            },
          ]
        : []),
      {
        type: "paragraph",
        id: "paragraph-2895",
        anchorId: statute ? "par_2895-odst_1" : "decision-paragraph",
        inlines: [{ type: "text", text }],
        plainText: text,
      },
    ],
  }) satisfies DocumentAst;
const decision = {
  ...dockedChatLegalPayloads.decision,
  caseNumber: "SYN 25/2023",
  decisionDate: "2023-06-01",
  identifiers: dockedChatLegalPayloads.decision.identifiers.map(
    (identifier) => ({ ...identifier, value: "SYN 25/2023" }),
  ),
  documentAst: makeAst(
    dockedChatLegalPayloads.decision.id,
    "Soud posoudil odpovědnost podle § 2895 OZ a dostupných důkazů.",
    false,
  ),
};
const current = {
  ...dockedChatLegalPayloads.statute,
  eli: "/eli/cz/sb/2012/89",
  title: "89/2012 Sb., syntetický občanský zákoník",
  documentAst: makeAst(
    dockedChatLegalPayloads.statute.id,
    CURRENT_PROVISION_SENTENCE,
    true,
  ),
};
const historical = {
  ...dockedChatLegalPayloads.olderStatute,
  effectiveDate: "2023-01-06",
  versionValidFrom: "2023-01-06",
  versionValidTo: "2024-01-01",
  eli: current.eli,
  title: current.title,
  documentAst: makeAst(
    dockedChatLegalPayloads.olderStatute.id,
    PROVISION_LAYOUT_SENTENCE,
    true,
  ),
};
const decisionSentence =
  "Soud posoudil odpovědnost podle § 2895 OZ a dostupných důkazů.";
const provisionRow = {
  jurisdiction: "CZE",
  workIdentifier: "89/2012 Sb.",
  workNumber: 89,
  workYear: 2012,
  workCollection: "Sb.",
  workEli: current.eli,
  workSource: null,
  unit: "section",
  section: 2895,
  sectionSuffix: null,
  subsection: null,
  letter: null,
  point: null,
  sentence: null,
  openEnded: false,
  anchor: "par_2895",
  versionValidFrom: historical.versionValidFrom,
  versionBasis: { type: "inferred", kind: "decision_date" },
  inferredVersionCandidate: {
    type: "inferred",
    kind: "decision_date",
    versionValidFrom: historical.versionValidFrom,
  },
  sentenceText: decisionSentence,
  spanStart: decisionSentence.indexOf("§"),
  spanEnd: decisionSentence.indexOf("§") + "§ 2895".length,
  confidence: 1,
  spanRole: null,
  printPieceId: null,
  printStart: null,
  printEnd: null,
  printText: null,
  namePieceId: null,
  nameStart: null,
  nameEnd: null,
  nameText: null,
  selection: null,
  printedWorkIdentifier: null,
  targetDocumentId: historical.id,
  targetStatus: null,
  previewKey: null,
} satisfies PublicLawData<
  ReturnType<typeof api.case.decisions>["provisions"]["get"]
>["items"][number];
export const PROVISION_LAYOUT_DECISION_PATH = createCaseLawDecisionPath(
  createCaseLawDecisionRouteParams({
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  }),
);

export const installProvisionLayoutFixture = async (
  page: Page,
  apiOrigin = E2E_API_ORIGIN,
) => {
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const sameOriginMount =
      url.origin === new URL(page.url()).origin &&
      url.pathname.startsWith("/api/v1/");
    if (url.origin !== new URL(apiOrigin).origin && !sameOriginMount) {
      await route.continue();
      return;
    }
    const path = (
      sameOriginMount ? url.pathname.slice(4) : url.pathname
    ).replace(/\/$/u, "");
    const respond = async (body: unknown) =>
      await route.fulfill({ json: body });
    if (
      path === `/v1/case/decisions/by-slug/${decision.slug}` ||
      path === `/v1/case/decisions/${decision.id}`
    ) {
      await respond(decision);
      return;
    }
    if (path.startsWith(`/v1/case/decisions/${decision.id}/`)) {
      if (path.endsWith("/analysis")) {
        await respond({
          status: "done",
          analysis: {
            version: 2,
            generatedAt: "2026-10-06T08:00:00.000Z",
            model: "synthetic",
            inputFingerprint: "f".repeat(64),
            tree: [],
          } satisfies DecisionAnalysis,
        });
        return;
      }
      if (path.endsWith("/provisions")) {
        await respond({
          ...dockedChatLegalPayloads.noProvisions,
          items: [provisionRow],
        });
        return;
      }
      if (path.endsWith("/citations/summary")) {
        await respond(dockedChatLegalPayloads.citationSummary);
        return;
      }
      if (path.endsWith("/citations/leading")) {
        await respond(dockedChatLegalPayloads.noLeadingCitations);
        return;
      }
      if (path.endsWith("/citations")) {
        await respond(dockedChatLegalPayloads.noCitations);
        return;
      }
    }
    if (path === "/v1/law/statutes/resolve") {
      await respond({
        items: [
          {
            asOf: historical.versionValidFrom,
            country: historical.country,
            eli: historical.eli,
            statute: historical,
            unresolvedReason: null,
          },
        ],
      } satisfies PublicLawData<typeof api.law.statutes.resolve.post>);
      return;
    }
    if (path.endsWith("/versions") && path.startsWith("/v1/law/statutes/")) {
      await respond({
        ...dockedChatLegalPayloads.versions,
        items: dockedChatLegalPayloads.versions.items.map((version) => ({
          ...version,
          eli: current.eli,
          title: current.title,
          ...(version.id === historical.id
            ? {
                effectiveDate: historical.effectiveDate,
                versionValidFrom: historical.versionValidFrom,
                versionValidTo: historical.versionValidTo,
              }
            : {}),
        })),
      });
      return;
    }
    for (const statute of [historical, current]) {
      if (
        path === `/v1/law/statutes/${statute.id}` ||
        path === `/v1/law/statutes/by-slug/${statute.slug}`
      ) {
        await respond(statute);
        return;
      }
      if (
        path === `/v1/law/statutes/${statute.id}/provisions/par_2895/preview`
      ) {
        await respond({
          documentId: statute.id,
          language: "cs",
          anchorId: "par_2895",
          citedAnchorId: null,
          headings: [],
          heading: {
            id: "heading-2895",
            anchorId: "par_2895",
            level: 2,
            text: "§ 2895",
          },
          blocks: [
            {
              id: "paragraph-2895",
              anchorId: "par_2895-odst_1",
              text:
                statute.id === historical.id
                  ? PROVISION_LAYOUT_SENTENCE
                  : CURRENT_PROVISION_SENTENCE,
            },
          ],
        });
        return;
      }
      if (
        path.includes(`/v1/law/statutes/${statute.id}/provisions/`) &&
        path.endsWith("/history")
      ) {
        await respond({ items: [], nextCursor: null, limit: 50 });
        return;
      }
    }
    if (path === "/v1/case/provisions/citing-decisions") {
      await respond({ items: [], nextCursor: null, limit: 50 });
      return;
    }
    await route.continue();
  });
};

export const openProvisionLayoutInspector = async (
  page: Page,
  webOrigin = "",
) => {
  await page.goto(`${webOrigin}/chat`, { waitUntil: "commit" });
  await page.locator("main").waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(
    (path) => history.pushState(null, "", path),
    PROVISION_LAYOUT_DECISION_PATH,
  );
  const citation = page
    .locator(".reader-case-law")
    .getByRole("link", { name: "§ 2895" })
    .first();
  await citation.waitFor({ state: "visible", timeout: 30_000 });
  await citation.click();
  await page
    .getByRole("button", { name: "Open provision", exact: true })
    .click();
  const article = page.locator(
    '[data-slot="inspector-dock-pane"] article.reader-statute',
  );
  await article
    .getByText(PROVISION_LAYOUT_SENTENCE, { exact: true })
    .waitFor({ state: "attached" });
  await page.mouse.click(700, 60);
  return article;
};

export const readProvisionLayout = async (page: Page) =>
  await page
    .locator('[data-slot="inspector-dock-pane"] article.reader-statute')
    .evaluate((article) => {
      const panel = article.closest('[data-slot="inspector-dock-pane"]');
      const paragraph = article.querySelector("p");
      if (
        panel === null ||
        paragraph === null ||
        article.parentElement === null
      ) {
        throw new Error("Provision fixture did not reach its layout boundary");
      }
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const style = getComputedStyle(article);
      return {
        width: article.getBoundingClientRect().width,
        panelWidth: panel.getBoundingClientRect().width,
        parentWidth: article.parentElement.getBoundingClientRect().width,
        lines: new Set(
          [...range.getClientRects()].map((rect) => Math.round(rect.top)),
        ).size,
        marginInlineStart: style.marginInlineStart,
        marginInlineEnd: style.marginInlineEnd,
        containerType: style.containerType,
        contain: style.contain,
      };
    });
