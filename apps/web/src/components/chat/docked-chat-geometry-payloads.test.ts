import { expect, test } from "bun:test";

import type {
  CorrespondenceRoutes,
  WebRoutes,
} from "@/generated/api-routes.gen";

import { decisionParagraphRangePayloads } from "../../../e2e/helpers/decision-paragraph-range-payloads";
import { dockedChatLegalPayloads } from "../../../e2e/helpers/docked-chat-legal-payloads";
import { dockedChatPagePayloads } from "../../../e2e/helpers/docked-chat-page-payloads";

type ApiRoutes = WebRoutes["v1"];
type DecisionReads = ApiRoutes["case"]["decisions"][":decisionId"];
type StatuteReads = ApiRoutes["law"]["statutes"][":documentId"];

// Check the exact payloads installed by E2E in the application's type graph;
// the Playwright project imports only their small inferred leaf modules.
const legalContracts = {
  decision:
    dockedChatLegalPayloads.decision satisfies DecisionReads["get"]["response"][200],
  bilingualDecision:
    dockedChatLegalPayloads.bilingualDecision satisfies DecisionReads["get"]["response"][200],
  bilingualCzechDecision:
    dockedChatLegalPayloads.bilingualCzechDecision satisfies DecisionReads["get"]["response"][200],
  statute:
    dockedChatLegalPayloads.statute satisfies StatuteReads["get"]["response"][200],
  olderStatute:
    dockedChatLegalPayloads.olderStatute satisfies StatuteReads["get"]["response"][200],
  noProvisions:
    dockedChatLegalPayloads.noProvisions satisfies DecisionReads["provisions"]["get"]["response"][200],
  noCitations:
    dockedChatLegalPayloads.noCitations satisfies DecisionReads["citations"]["get"]["response"][200],
  noLeadingCitations:
    dockedChatLegalPayloads.noLeadingCitations satisfies DecisionReads["citations"]["leading"]["get"]["response"][200],
  citationSummary:
    dockedChatLegalPayloads.citationSummary satisfies DecisionReads["citations"]["summary"]["get"]["response"][200],
  versions:
    dockedChatLegalPayloads.versions satisfies StatuteReads["versions"]["get"]["response"][200],
} satisfies Record<keyof typeof dockedChatLegalPayloads, unknown>;

const paragraphRangeContracts = {
  decision:
    decisionParagraphRangePayloads.decision satisfies DecisionReads["get"]["response"][200],
  unavailable:
    decisionParagraphRangePayloads.unavailable satisfies DecisionReads["get"]["response"][200],
} satisfies Record<keyof typeof decisionParagraphRangePayloads, unknown>;

const pages = dockedChatPagePayloads({
  workspaceId: "019a0000-0000-7000-8000-000000000001",
  resourceId: "019a0000-0000-7000-8000-000000000002",
});
const pageContracts = {
  invoice:
    pages.invoice satisfies ApiRoutes["invoices"][":workspaceId"][":invoiceId"]["get"]["response"][200],
  report:
    pages.report satisfies ApiRoutes["workspaces"][":workspaceId"]["reports"][":exportId"]["get"]["response"][200],
  correspondence:
    pages.correspondence satisfies CorrespondenceRoutes["v1"]["workspaces"][":workspaceId"]["correspondence"][":correspondenceId"]["get"]["response"][200],
  registryLookup:
    pages.registryLookup satisfies ApiRoutes["contacts"]["business-registries"]["get"]["response"][200],
} satisfies Record<keyof typeof pages, unknown>;

test("every installed docked-chat geometry payload has an HTTP contract check", () => {
  expect(Object.keys(legalContracts).toSorted()).toEqual(
    Object.keys(dockedChatLegalPayloads).toSorted(),
  );
  expect(Object.keys(paragraphRangeContracts).toSorted()).toEqual(
    Object.keys(decisionParagraphRangePayloads).toSorted(),
  );
  expect(Object.keys(pageContracts).toSorted()).toEqual(
    Object.keys(pages).toSorted(),
  );
});
