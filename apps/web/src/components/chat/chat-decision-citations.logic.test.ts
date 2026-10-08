import { expect, test } from "bun:test";
import fc from "fast-check";

import { toChatDecisionPassageHref } from "@stll/api-contract";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { toSafeId } from "@stll/api-contract/safe-id";
import { assertProperty } from "@stll/property-testing";

import {
  chatAnswerCitationHrefs,
  chatAnswerDecisionTargets,
  chatAnswerMarkdownDocuments,
} from "@/components/chat/chat-decision-citations.logic";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import type { ExternalSourceReference } from "@/components/chat/external-source-store";
import { collectSourceChipEntries } from "@/components/chat/source-chips.logic";

const firstId = "019a0000-0000-7000-8000-000000000101";
const secondId = "019a0000-0000-7000-8000-000000000103";
const origins = new Set(["https://app.example.test"]);
const publisherUrl = "https://publisher.example.test/decision/one";
const secondPublisherUrl = "https://publisher.example.test/decision/two";
const sources = [
  {
    title: "First decision",
    url: publisherUrl,
    caseLawDecision: { decisionId: firstId, caseNumber: "SYN 1/2026" },
  },
  {
    title: "Second decision",
    url: secondPublisherUrl,
    caseLawDecision: { decisionId: secondId, caseNumber: "SYN 2/2026" },
  },
] satisfies ExternalSourceReference[];
const decisionHref = (decisionId: string) =>
  toChatDecisionPassageHref({
    decisionId: toSafeId<"caseLawDecision">(decisionId),
    anchorId: "p-12",
  });
const targets = (markdown: string) =>
  chatAnswerDecisionTargets({
    markdownDocuments: [markdown],
    sources,
    appOrigins: origins,
  });

test("only rendered Markdown links identify decisions, excluding code images and unused definitions", () => {
  const cited = decisionHref(firstId);
  const uncited = decisionHref(secondId);
  const markdown = `[Applied reasons](${cited})\n\n[repeat][reasons]\n\n[reasons]: ${cited}\n[unused]: ${uncited}\n\n\`[code](${uncited})\`\n\n\`\`\`md\n[code block](${uncited})\n\`\`\`\n\n![image](${uncited})`;
  expect(chatAnswerCitationHrefs(markdown)).toEqual([cited, cited]);
  expect(targets(markdown)).toEqual([{ type: "id", decisionId: firstId }]);
});

test("publisher aliases and GFM links count only the cited decision rather than all returned hits", () => {
  expect(
    targets(`${publisherUrl}\n\n[Same decision](${decisionHref(firstId)})`),
  ).toEqual([{ type: "id", decisionId: firstId }]);
  expect(
    targets(`[First](${publisherUrl}) and [Second](${secondPublisherUrl}).`),
  ).toEqual([
    { type: "id", decisionId: firstId },
    { type: "id", decisionId: secondId },
  ]);
});

test("slug citations retain the canonical route target for hydration instead of inventing an ID", () => {
  const params = createCaseLawDecisionRouteParams({
    decisionId: firstId,
    caseNumber: "SYN 1/2026",
    country: "CZE",
    court: "Synthetic court",
    language: "cs",
    languageAlternates: [],
    slug: "synthetic-citation-decision",
  });
  const href = createCaseLawDecisionPath(params);
  expect(targets(`[Reasons](${href})`)).toEqual([{ type: "route", params }]);
  expect(
    targets(`[Foreign lookalike](https://foreign.example.test${href})`),
  ).toEqual([]);
});

test("only visible clarification analysis contributes Markdown and connector identity remains external", () => {
  const analysis = `[Reasons](${decisionHref(firstId)})`;
  const message = {
    id: "assistant-clarification",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "ask",
        name: "ask-user",
        state: "input-complete",
        arguments: "{}",
        input: {
          analysis,
          questions: [
            {
              question: "Which governing law applies?",
              reason: "The answer changes the legal assessment.",
            },
          ],
        },
      },
    ],
  } satisfies ChatUIMessage;
  expect(chatAnswerMarkdownDocuments(message, true)).toEqual([analysis]);
  expect(chatAnswerMarkdownDocuments(message, false)).toEqual([]);
  const external = {
    id: "assistant-external",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "mcp-search",
        name: "mcp__external__search",
        state: "complete",
        arguments: "{}",
        output: {
          decisionId: firstId,
          caseNumber: "SYN 1/2026",
          url: publisherUrl,
          court: "Nejvyšší soud",
          country: "CZE",
          decisionDate: "2026-01-01",
        },
      },
    ],
  } satisfies ChatUIMessage;
  const extracted = collectSourceChipEntries({
    parts: external.parts,
  }).uniqueExternalSources;
  expect(extracted).toHaveLength(1);
  expect(extracted.at(0)?.caseLawDecision).toBeUndefined();
  expect(
    chatAnswerDecisionTargets({
      markdownDocuments: [`[External](${publisherUrl})`],
      sources: extracted,
      appOrigins: origins,
    }),
  ).toEqual([]);
  expect(chatAnswerMarkdownDocuments(external, true)).toEqual([]);
});

test("Markdown citation repetition and code wrapping preserve canonical identity ownership", () => {
  assertProperty(
    "Markdown citation repetition and code wrapping preserve canonical identity ownership",
    fc.property(fc.uuid(), fc.uuid(), (citedId, codeId) => {
      const citedHref = decisionHref(citedId);
      const codeHref = decisionHref(codeId);
      const markdown = `[Reasons](${citedHref}) and [again](${citedHref})\n\n\`[not a citation](${codeHref})\``;
      expect(targets(markdown)).toEqual([{ type: "id", decisionId: citedId }]);
    }),
  );
});

test("reference definitions stay scoped to the Markdown document that actually renders them", () => {
  const definition = `[reasons]: ${decisionHref(firstId)}`;
  const reference = "[Reasons][reasons]";
  expect(
    chatAnswerDecisionTargets({
      markdownDocuments: [reference, definition],
      sources,
      appOrigins: origins,
    }),
  ).toEqual([]);
  expect(
    chatAnswerDecisionTargets({
      markdownDocuments: [`${reference}\n\n${definition}`],
      sources,
      appOrigins: origins,
    }),
  ).toEqual([{ type: "id", decisionId: firstId }]);
});

test("the first reference definition wins in source order including nested blocks", () => {
  const first = decisionHref(firstId);
  const second = decisionHref(secondId);
  expect(
    targets(
      `> [reasons]: ${first}\n\n[reasons]: ${second}\n\n[Applied reasons][reasons]`,
    ),
  ).toEqual([{ type: "id", decisionId: firstId }]);
});
