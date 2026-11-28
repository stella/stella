import { describe, expect, it } from "bun:test";
import * as v from "valibot";

import {
  CHAT_DECISION_PASSAGE_HREF_PREFIX,
  CHAT_RESOURCE_HREF_PREFIX,
  CHAT_SOURCE_CITATION_HREF_PREFIX,
  parseCanonicalChatSourceCitationHref,
  parseChatDecisionPassageHref,
  parseChatResourceHref,
  replaceCanonicalChatSourceCitationHrefs,
  RESOURCE_TYPE,
  toChatDecisionPassageHref,
  toChatResourceHref,
  toChatSourceCitationHref,
} from "@stll/api-contract";
import type { ChatSourceCitationTarget } from "@stll/api-contract";
import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";
import { markdownToStellaDocument } from "@stll/docx-authoring/markdown";
import { answerQuoteKey } from "@stll/legal-ast/answer-quote";
import type { Block } from "@stll/legal-ast/document-ast";

import type { JustificationBlock } from "@/api/db/schema";
import { checkAnswerQuotes } from "@/api/handlers/chat/answer-quote-checks";
import {
  buildCitationSection,
  getChatExportCitationLabels,
  resolveExportCitations,
  sourceDocumentsToCitations,
} from "@/api/handlers/chat/export/citation-footnotes";
import { composeExportMarkdown } from "@/api/handlers/chat/export/export-shared";
import { styleDocumentCitationsWithCounts } from "@/api/handlers/chat/export/style-document-citations";
import type { ChatMessageMetadata, ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { formatCourtParagraphMark } from "@/api/lib/case-law/court-paragraph-mark";
import type { DecisionBlocksByDecision } from "@/api/lib/case-law/court-paragraph-numbers";
import {
  verifyQuoteArgsSchema,
  verifyQuoteOutputSchema,
} from "@/api/mcp/verify-quote-tools";
import { verifyQuote } from "@/api/mcp/verify-quote.logic";

import {
  largePublicQuoteDecision,
  publicQuoteCases,
  publicQuoteDecisions,
} from "../../../evals/lib/verify-quote-cases";

// ---------------------------------------------------------------------------
// Deterministic public multilingual court & statute fixtures (zero LLM / DB)
// ---------------------------------------------------------------------------

const DEC_CZ_NS = toSafeId<"caseLawDecision">(
  "01990000-00a4-7000-8000-000000000101",
);
const DEC_CZ_US = toSafeId<"caseLawDecision">(
  "01990000-00a4-7000-8000-000000000102",
);
const DEC_SK_US = toSafeId<"caseLawDecision">(
  "01990000-00a4-7000-8000-000000000103",
);
const DEC_PL_SN = toSafeId<"caseLawDecision">(
  "01990000-00a4-7000-8000-000000000104",
);
const DEC_EU_CJEU = toSafeId<"caseLawDecision">(
  "01990000-00a4-7000-8000-000000000105",
);
const DEC_US_SCOTUS = toSafeId<"caseLawDecision">(
  "01990000-00a4-7000-8000-000000000106",
);

const CZ_NS_TEXT =
  "Je-li dovolání podáno někým, kdo k dovolání není oprávněn, dovolací soud jej odmítne ve lhůtě 30 dnů od předložení spisu.";
const CZ_US_TEXT =
  "Obecným pravidlem je ale rozhodování senátní, rozhodování samosoudcovské představuje výjimku, přičemž stěžovatel nebyl zbaven práva na zákonného soudce.";
const SK_US_TEXT =
  "Súčasťou základného práva na súdnu ochranu je aj právo účastníka konania na také odôvodnenie súdneho rozhodnutia, ktoré jasne a zrozumiteľne dáva odpovede na všetky právne a skutkovo relevantné otázky.";
const PL_SN_TEXT =
  "Sąd Najwyższy podkreślił, że wykładnia umowy nie może pomijać zgodnego zamiaru stron i celu umowy, lecz powinna uwzględniać także okoliczności jej zawarcia.";
const EU_CJEU_TEXT =
  "According to settled case-law, the principle of effective judicial protection of individuals' rights under EU law is a general principle of EU law stemming from the constitutional traditions common to the Member States.";
const US_SCOTUS_TEXT =
  "It is emphatically the province and duty of the Judicial Department to say what the law is — those who apply the rule to particular cases must, of necessity, expound and interpret that rule.";

const makeParagraphBlock = (
  anchorId: string,
  number: number,
  text: string,
): Block => ({
  anchorId,
  id: anchorId,
  inlines: [{ text, type: "text" }],
  number,
  plainText: text,
  type: "paragraph",
});

const CORPUS_BLOCKS: DecisionBlocksByDecision = new Map([
  [DEC_CZ_NS, [makeParagraphBlock("p-28", 16, CZ_NS_TEXT)]],
  [DEC_CZ_US, [makeParagraphBlock("p-12", 8, CZ_US_TEXT)]],
  [DEC_SK_US, [makeParagraphBlock("p-41", 22, SK_US_TEXT)]],
  [DEC_PL_SN, [makeParagraphBlock("p-19", 9, PL_SN_TEXT)]],
  [DEC_EU_CJEU, [makeParagraphBlock("p-34", 34, EU_CJEU_TEXT)]],
  [DEC_US_SCOTUS, [makeParagraphBlock("p-7", 7, US_SCOTUS_TEXT)]],
]);

const answerMessage = (...contents: string[]) => ({
  parts: contents.map((content): ChatPart => ({ type: "text", content })),
});

const recordingLoader = (corpus: DecisionBlocksByDecision) => {
  const requested: string[][] = [];
  const load: Parameters<typeof checkAnswerQuotes>[0]["load"] = async (
    decisionIds,
  ) => {
    requested.push([...decisionIds]);
    return await Promise.resolve(
      new Map([...corpus].filter(([id]) => decisionIds.includes(id))),
    );
  };
  return { load, requested };
};

const APP_ORIGINS: ReadonlySet<string> = new Set(["https://app.stella.test"]);

const INTERNAL_HREF_PREFIXES = [
  CHAT_DECISION_PASSAGE_HREF_PREFIX,
  CHAT_RESOURCE_HREF_PREFIX.case_law_decision,
  CHAT_RESOURCE_HREF_PREFIX.entity,
  CHAT_RESOURCE_HREF_PREFIX.workspace,
  CHAT_SOURCE_CITATION_HREF_PREFIX,
] as const;

const exportDocumentWithFootnotes = (
  bodyMarkdown: string,
  citations: ReturnType<typeof resolveExportCitations>,
  locale: "cs" | "en" = "cs",
) => {
  const labels = getChatExportCitationLabels(locale);
  const section = buildCitationSection(citations, "footnotes", labels);
  const composed = composeExportMarkdown(bodyMarkdown, section);
  const styled = styleDocumentCitationsWithCounts(
    markdownToStellaDocument(composed),
    "footnotes",
    {
      folioSourceTitle: undefined,
      formatParagraphMark: (courtParagraphNumber) =>
        formatCourtParagraphMark(labels.locale, courtParagraphNumber),
      internalCitationFallback: labels.citation,
      internalReferenceMode: "verified-citations",
      unverifiedCitationLabel: labels.unverifiedCitation,
    },
  );
  return {
    section,
    composed,
    styled,
    serialized: JSON.stringify(styled.document),
  };
};

const expectNoLeakedInternalTokens = (serialized: string) => {
  for (const prefix of INTERNAL_HREF_PREFIXES) {
    expect(serialized).not.toContain(prefix);
  }
};

// ---------------------------------------------------------------------------
// Part A — End-to-End Legal-Grounding & Citation-Pipeline Golden Matrix
// ---------------------------------------------------------------------------

describe("Part A: End-to-end legal-grounding & citation-pipeline golden replay", () => {
  it("1. verifies an exact verbatim CZ Supreme Court quote with passage citation and renders clean footnotes", async () => {
    const passageHref = toChatDecisionPassageHref({
      decisionId: DEC_CZ_NS,
      anchorId: "p-28",
      courtParagraphNumber: 16,
    });
    expect(parseChatDecisionPassageHref(passageHref)).toEqual({
      decisionId: DEC_CZ_NS,
      anchorId: "p-28",
      courtParagraphNumber: 16,
    });

    const markdown = `Podle [NS ČR 21 Cdo 476/2015](${passageHref}):\n\n> „${CZ_NS_TEXT}“`;
    const { load, requested } = recordingLoader(CORPUS_BLOCKS);
    const outcome = await checkAnswerQuotes({
      message: answerMessage(markdown),
      load,
    });

    expect(requested).toEqual([[DEC_CZ_NS]]);
    expect(outcome).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(CZ_NS_TEXT),
          decisionId: DEC_CZ_NS,
          anchorId: "p-28",
          paragraph: 16,
        },
      ],
    });

    const verified = verifyQuote({
      text: CZ_NS_TEXT,
      quote: CZ_NS_TEXT,
      located: [],
      url: null,
    });
    expect(verified.status).toBe("exact");
    expect(verified.verified).toBe(true);

    const exported = exportDocumentWithFootnotes(markdown, [], "cs");
    expect(exported.styled.document.package.footnotes).toHaveLength(1);
    expect(exported.serialized).toContain("NS ČR 21 Cdo 476/2015");
    expect(exported.serialized).toContain("16");
    expectNoLeakedInternalTokens(exported.serialized);
  });

  it("2. verifies a legitimate CZ quote with typography/whitespace normalization and elision ([…])", async () => {
    const elidedQuote =
      "Je-li\u00a0dovolání podáno někým, kdo k dovolání není oprávněn […] dovolací soud jej odmítne ve lhůtě 30\u00a0dnů od předložení spisu.";
    const decisionHref = toChatResourceHref({
      type: RESOURCE_TYPE.CASE_LAW_DECISION,
      resource: { type: RESOURCE_TYPE.CASE_LAW_DECISION, id: DEC_CZ_NS },
    });
    expect(parseChatResourceHref(decisionHref)).toEqual({
      type: RESOURCE_TYPE.CASE_LAW_DECISION,
      resource: { type: RESOURCE_TYPE.CASE_LAW_DECISION, id: DEC_CZ_NS },
    });

    const { load } = recordingLoader(CORPUS_BLOCKS);
    const outcome = await checkAnswerQuotes({
      message: answerMessage(
        `Viz [NS ČR](${decisionHref}):\n\n> ${elidedQuote}`,
      ),
      load,
    });

    expect(outcome).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(elidedQuote),
          decisionId: DEC_CZ_NS,
          anchorId: "p-28",
          paragraph: 16,
        },
      ],
    });

    const verified = verifyQuote({
      text: CZ_NS_TEXT,
      quote: elidedQuote,
      located: [],
      url: null,
    });
    expect(verified.status).toBe("exact");
    expect(verified.verified).toBe(true);
  });

  it("3. verifies a Slovak (SK) Constitutional Court verbatim quote end to end", async () => {
    const href = toChatDecisionPassageHref({
      decisionId: DEC_SK_US,
      anchorId: "p-41",
      courtParagraphNumber: 22,
    });
    const markdown = `Ústavný súd SR v [náleze](${href}) uviedol:\n\n> ${SK_US_TEXT}`;
    const { load } = recordingLoader(CORPUS_BLOCKS);

    const outcome = await checkAnswerQuotes({
      message: answerMessage(markdown),
      load,
    });
    expect(outcome).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(SK_US_TEXT),
          decisionId: DEC_SK_US,
          anchorId: "p-41",
          paragraph: 22,
        },
      ],
    });
    expect(
      verifyQuote({
        text: SK_US_TEXT,
        quote: SK_US_TEXT,
        located: [],
        url: null,
      }).verified,
    ).toBe(true);
  });

  it("4. verifies a Polish (PL) Supreme Court (SN) verbatim quote end to end", async () => {
    const href = toChatDecisionPassageHref({
      decisionId: DEC_PL_SN,
      anchorId: "p-19",
      courtParagraphNumber: 9,
    });
    const markdown = `Zgodnie z wyrokiem [Sądu Najwyższego](${href}):\n\n> ${PL_SN_TEXT}`;
    const { load } = recordingLoader(CORPUS_BLOCKS);

    const outcome = await checkAnswerQuotes({
      message: answerMessage(markdown),
      load,
    });
    expect(outcome).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(PL_SN_TEXT),
          decisionId: DEC_PL_SN,
          anchorId: "p-19",
          paragraph: 9,
        },
      ],
    });
    expect(
      verifyQuote({
        text: PL_SN_TEXT,
        quote: PL_SN_TEXT,
        located: [],
        url: null,
      }).verified,
    ).toBe(true);
  });

  it("5. verifies an EU CJEU quote with [...] elision and resolves statute/decision reader links", async () => {
    const elidedEu =
      "According to settled case-law, the principle of effective judicial protection [...] is a general principle of EU law stemming from the constitutional traditions common to the Member States.";
    const href = toChatDecisionPassageHref({
      decisionId: DEC_EU_CJEU,
      anchorId: "p-34",
      courtParagraphNumber: 34,
    });
    const { load } = recordingLoader(CORPUS_BLOCKS);

    const outcome = await checkAnswerQuotes({
      message: answerMessage(`See [CJEU](${href}):\n\n> ${elidedEu}`),
      load,
    });
    expect(outcome).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(elidedEu),
          decisionId: DEC_EU_CJEU,
          anchorId: "p-34",
          paragraph: 34,
        },
      ],
    });
    expect(
      verifyQuote({
        text: EU_CJEU_TEXT,
        quote: elidedEu,
        located: [],
        url: null,
      }),
    ).toMatchObject({ status: "exact", verified: true });

    const statuteLink = resolveLegalCitationLinks({
      url: "https://app.stella.test/law/cze/statutes/89-2012",
      sourceUrl: "https://www.e-sbirka.cz/sb/2012/89",
      appOrigins: APP_ORIGINS,
    });
    expect(statuteLink).toMatchObject({
      type: "statute",
      url: "https://app.stella.test/law/cze/statutes/89-2012",
      source_url: "https://www.e-sbirka.cz/sb/2012/89",
    });
  });

  it("6. verifies a US Supreme Court quote with dash and smart-quote normalization", async () => {
    const normalizedUs =
      "It is emphatically the province and duty of the Judicial Department to say what the law is - those who apply the rule to particular cases must, of necessity, expound and interpret that rule.";
    const href = toChatResourceHref({
      type: RESOURCE_TYPE.CASE_LAW_DECISION,
      resource: { type: RESOURCE_TYPE.CASE_LAW_DECISION, id: DEC_US_SCOTUS },
    });
    const { load } = recordingLoader(CORPUS_BLOCKS);

    const outcome = await checkAnswerQuotes({
      message: answerMessage(
        `In [Marbury v. Madison](${href}):\n\n> “${normalizedUs}”`,
      ),
      load,
    });
    expect(outcome).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(normalizedUs),
          decisionId: DEC_US_SCOTUS,
          anchorId: "p-7",
          paragraph: 7,
        },
      ],
    });
    expect(
      verifyQuote({
        text: US_SCOTUS_TEXT,
        quote: normalizedUs,
        located: [],
        url: null,
      }),
    ).toMatchObject({ status: "exact", verified: true });
  });

  it("7. rejects subtle negation tampering ('nebyl' -> 'byl' and 'není' -> 'je')", async () => {
    const tamperedNegationA = CZ_US_TEXT.replace("nebyl", "byl");
    const tamperedNegationB = CZ_NS_TEXT.replace(
      "není oprávněn",
      "je oprávněn",
    );
    const { load } = recordingLoader(CORPUS_BLOCKS);

    const outcome = await checkAnswerQuotes({
      message: answerMessage(
        `[1](#stella-decision=${DEC_CZ_US}) [2](#stella-decision=${DEC_CZ_NS})\n\n> ${tamperedNegationA}\n\n> ${tamperedNegationB}`,
      ),
      load,
    });

    expect(outcome).toEqual({
      type: "checked",
      checks: [
        { type: "unverified", key: answerQuoteKey(tamperedNegationA) },
        { type: "unverified", key: answerQuoteKey(tamperedNegationB) },
      ],
    });

    const verifiedA = verifyQuote({
      text: CZ_US_TEXT,
      quote: tamperedNegationA,
      located: [],
      url: null,
    });
    const verifiedB = verifyQuote({
      text: CZ_NS_TEXT,
      quote: tamperedNegationB,
      located: [],
      url: null,
    });
    expect(verifiedA.status).toBe("fuzzy");
    expect(verifiedA.verified).toBe(false);
    expect(verifiedB.status).toBe("fuzzy");
    expect(verifiedB.verified).toBe(false);
  });

  it("8. rejects subtle statutory number / deadline tampering ('30 dnů' -> '15 dnů')", async () => {
    const tamperedDeadline = CZ_NS_TEXT.replace("30 dnů", "15 dnů");
    const { load } = recordingLoader(CORPUS_BLOCKS);

    const outcome = await checkAnswerQuotes({
      message: answerMessage(
        `[1](#stella-decision-passage=${DEC_CZ_NS}:p-28)\n\n> ${tamperedDeadline}`,
      ),
      load,
    });
    expect(outcome).toEqual({
      type: "checked",
      checks: [{ type: "unverified", key: answerQuoteKey(tamperedDeadline) }],
    });

    const verified = verifyQuote({
      text: CZ_NS_TEXT,
      quote: tamperedDeadline,
      located: [],
      url: null,
    });
    expect(verified.status).toBe("fuzzy");
    expect(verified.verified).toBe(false);
  });

  it("9. rejects diacritic stripping / word-level corruption rather than silently verifying", async () => {
    const strippedDiacritics = CZ_NS_TEXT.replace("oprávněn", "opravnen");
    const { load } = recordingLoader(CORPUS_BLOCKS);

    const outcome = await checkAnswerQuotes({
      message: answerMessage(
        `[1](#stella-decision=${DEC_CZ_NS})\n\n> ${strippedDiacritics}`,
      ),
      load,
    });
    expect(outcome).toEqual({
      type: "checked",
      checks: [{ type: "unverified", key: answerQuoteKey(strippedDiacritics) }],
    });

    const verified = verifyQuote({
      text: CZ_NS_TEXT,
      quote: strippedDiacritics,
      located: [],
      url: null,
    });
    expect(verified.status).toBe("fuzzy");
    expect(verified.verified).toBe(false);
  });

  it("10. rejects cross-decision misattribution (verbatim quote from Decision A attributed only to Decision B)", async () => {
    const { load, requested } = recordingLoader(CORPUS_BLOCKS);
    const outcome = await checkAnswerQuotes({
      message: answerMessage(
        `Podle [Ústavního soudu](#stella-decision=${DEC_CZ_US}):\n\n> ${CZ_NS_TEXT}`,
      ),
      load,
    });

    expect(requested).toEqual([[DEC_CZ_US]]);
    expect(outcome).toEqual({
      type: "checked",
      checks: [{ type: "unverified", key: answerQuoteKey(CZ_NS_TEXT) }],
    });

    const verified = verifyQuote({
      text: CZ_US_TEXT,
      quote: CZ_NS_TEXT,
      located: [],
      url: null,
    });
    expect(verified.status).toBe("not_found");
    expect(verified.verified).toBe(false);
  });

  it("11. marks an uncited / fabricated quote unchecked without loading decisions and rejects it in verifyQuote", async () => {
    const fabricated =
      "Soud jednomyslně dovodil, že automatizovaná analýza všech digitálních podkladů zakládá nevyvratitelnou domněnku oprávněnosti žalobního nároku.";
    const { load, requested } = recordingLoader(CORPUS_BLOCKS);

    const outcome = await checkAnswerQuotes({
      message: answerMessage(`Bez uvedení pramene:\n\n> ${fabricated}`),
      load,
    });

    expect(requested).toEqual([]);
    expect(outcome).toEqual({
      type: "checked",
      checks: [{ type: "unchecked", key: answerQuoteKey(fabricated) }],
    });

    const verified = verifyQuote({
      text: CZ_NS_TEXT,
      quote: fabricated,
      located: [],
      url: null,
    });
    expect(verified.status).toBe("not_found");
    expect(verified.verified).toBe(false);
  });

  it("12. handles a mixed memo (1 valid + 1 tampered quote + statute/case-law links + verified/unverified export citations) with zero leaked internal tokens", async () => {
    const tamperedUs = CZ_US_TEXT.replace("nebyl", "byl");
    const nsPassageHref = toChatDecisionPassageHref({
      decisionId: DEC_CZ_NS,
      anchorId: "p-28",
      courtParagraphNumber: 16,
    });
    const usDecisionHref = toChatResourceHref({
      type: RESOURCE_TYPE.CASE_LAW_DECISION,
      resource: { type: RESOURCE_TYPE.CASE_LAW_DECISION, id: DEC_CZ_US },
    });

    const markdown = [
      `Podle [NS ČR 21 Cdo 476/2015](${nsPassageHref}) a zákona [89/2012 Sb.](https://app.stella.test/law/cze/statutes/89-2012):`,
      "",
      `> ${CZ_NS_TEXT}`,
      "",
      `Naopak [ÚS ČR](${usDecisionHref}) údajně uvedl:`,
      "",
      `> ${tamperedUs}`,
    ].join("\n");

    const { load, requested } = recordingLoader(CORPUS_BLOCKS);
    const quoteOutcome = await checkAnswerQuotes({
      message: answerMessage(markdown),
      load,
    });

    expect(requested).toEqual([[DEC_CZ_NS, DEC_CZ_US]]);
    expect(quoteOutcome).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(CZ_NS_TEXT),
          decisionId: DEC_CZ_NS,
          anchorId: "p-28",
          paragraph: 16,
        },
        {
          type: "unverified",
          key: answerQuoteKey(tamperedUs),
        },
      ],
    });

    const decisionLink = resolveLegalCitationLinks({
      url: "https://app.stella.test/law/cze/cases/nejvyssi-soud/21-cdo-476-2015",
      sourceUrl: "https://nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/1",
      appOrigins: APP_ORIGINS,
    });
    expect(decisionLink).toMatchObject({
      type: "decision",
      url: "https://app.stella.test/law/cze/cases/nejvyssi-soud/21-cdo-476-2015",
      source_url: "https://nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch/1",
    });

    const justificationBlocks: JustificationBlock[] = [
      {
        kind: "pdf-bates",
        fileFieldId: toSafeId<"field">("field-exhibit-1"),
        statements: [
          {
            text: "Notice delivered on day 14.",
            citations: [{ bates: "EXH-0014", pageNumber: 4 }],
          },
        ],
      },
      {
        kind: "docx-folio",
        fileFieldId: toSafeId<"field">("field-contract-1"),
        statements: [
          {
            text: "Clause 8.2 caps liability.",
            citations: [
              {
                blockId: "blk-8-2",
                text: "Clause 8.2 — Liability cap is limited to annual fees.",
                citationStatus: "verified",
              },
              {
                text: "Fabricated indemnity text that must never be laundered.",
                citationStatus: "unverified",
              },
            ],
          },
        ],
      },
    ];

    const resolvedCitations = resolveExportCitations(
      justificationBlocks,
      new Map([["field-exhibit-1", "Exhibit A.pdf"]]),
    );
    const exported = exportDocumentWithFootnotes(
      markdown,
      resolvedCitations,
      "cs",
    );

    expect(exported.section.verifiedCount).toBe(2);
    expect(exported.section.unverifiedCount).toBe(1);
    expect(exported.section.markdown).toContain(
      "Exhibit A.pdf, EXH-0014 (p. 4)",
    );
    expect(exported.section.markdown).toContain("Clause 8.2");
    expect(exported.section.markdown).not.toContain(
      "Fabricated indemnity text that must never be laundered.",
    );
    expect(exported.section.markdown).toContain(
      "Vynechané neověřené citace: 1",
    );
    expect(exported.styled.document.package.footnotes).toHaveLength(3);
    expect(exported.styled.citationCounts.verified).toBe(1);
    expectNoLeakedInternalTokens(exported.serialized);
  });

  it("13. enforces canonical #stella-source= round-trip, rejects forged source hrefs, and fails closed on untrusted metadata provenance", () => {
    const docxTarget: ChatSourceCitationTarget = {
      type: "docx-folio",
      workspaceId: toSafeId<"workspace">("ws-legal-1"),
      entityId: toSafeId<"entity">("ent-contract-1"),
      entityVersionId: toSafeId<"entityVersion">("ver-1"),
      fieldId: toSafeId<"field">("fld-1"),
      blockId: "blk-42",
      text: "Section 4.1 (Confidentiality)",
    };
    const batesTarget: ChatSourceCitationTarget = {
      type: "pdf-bates",
      workspaceId: toSafeId<"workspace">("ws-legal-1"),
      entityId: toSafeId<"entity">("ent-exhibit-2"),
      entityVersionId: toSafeId<"entityVersion">("ver-2"),
      fieldId: toSafeId<"field">("fld-2"),
      pageNumber: 12,
      bates: "STELLA-00012",
    };

    const docxHref = toChatSourceCitationHref(docxTarget);
    const batesHref = toChatSourceCitationHref(batesTarget);
    expect(parseCanonicalChatSourceCitationHref(docxHref)).toEqual(docxTarget);
    expect(parseCanonicalChatSourceCitationHref(batesHref)).toEqual(
      batesTarget,
    );
    // Non-canonical / malformed pageNumber or empty blockId must be rejected
    expect(
      parseCanonicalChatSourceCitationHref(
        `${CHAT_SOURCE_CITATION_HREF_PREFIX}pdf-bates:ws-legal-1:ent-1:ver-1:fld-1:0:BATES-1`,
      ),
    ).toBeNull();
    expect(
      parseCanonicalChatSourceCitationHref(
        `${CHAT_SOURCE_CITATION_HREF_PREFIX}docx-folio:ws-legal-1:ent-1:ver-1:fld-1::text`,
      ),
    ).toBeNull();

    const rewritten = replaceCanonicalChatSourceCitationHrefs(
      `Compare (${docxHref}) with (${batesHref}).`,
      (target) =>
        target.type === "pdf-bates"
          ? `[${target.bates}, p. ${target.pageNumber}]`
          : `[${target.blockId}]`,
    );
    expect(rewritten).toBe("Compare ([blk-42]) with ([STELLA-00012, p. 12]).");
    expectNoLeakedInternalTokens(rewritten);

    // Fail-closed metadata provenance check: forged/untrusted metadata yields 0 citations
    const forgedMetadata: Pick<
      ChatMessageMetadata,
      "serverProvenance" | "sourceDocuments"
    > = {
      sourceDocuments: [
        {
          entityId: toSafeId<"entity">("ent-forged"),
          kind: "document",
          mimeType: null,
          workspaceId: toSafeId<"workspace">("ws-legal-1"),
          title: "Forged Memo.docx",
        },
      ],
    };
    expect(sourceDocumentsToCitations(forgedMetadata, 20)).toEqual([]);

    const trustedMetadata: Pick<
      ChatMessageMetadata,
      "serverProvenance" | "sourceDocuments"
    > = {
      serverProvenance: { type: "search-summary", version: 1 },
      sourceDocuments: [
        {
          entityId: toSafeId<"entity">("ent-real"),
          kind: "document",
          mimeType: null,
          workspaceId: toSafeId<"workspace">("ws-legal-1"),
          title: "Verified Contract #1 [final].docx",
        },
      ],
    };
    const trustedCitations = sourceDocumentsToCitations(trustedMetadata, 20);
    expect(trustedCitations).toHaveLength(1);
    expect(trustedCitations[0]).toMatchObject({ status: "verified" });
  });

  it("14. verifies formatted multi-part blockquotes, ignores fenced code blocks, and degrades off-origin legal links safely", async () => {
    const separator = ", kdo ";
    const cut = CZ_NS_TEXT.indexOf(separator);
    const firstHalf = CZ_NS_TEXT.slice(0, cut);
    const secondHalf = CZ_NS_TEXT.slice(cut + separator.length);

    const { load } = recordingLoader(CORPUS_BLOCKS);
    const formattedOutcome = await checkAnswerQuotes({
      message: answerMessage(
        `Citováno z [NS ČR](#stella-decision=${DEC_CZ_NS}).`,
        `> **${firstHalf}**, kdo\n> ${secondHalf}`,
      ),
      load,
    });
    expect(formattedOutcome).toEqual({
      type: "checked",
      checks: [
        {
          type: "verified",
          key: answerQuoteKey(CZ_NS_TEXT),
          decisionId: DEC_CZ_NS,
          anchorId: "p-28",
          paragraph: 16,
        },
      ],
    });

    const codeOnlyLoader = recordingLoader(CORPUS_BLOCKS);
    const codeOnlyOutcome = await checkAnswerQuotes({
      message: answerMessage(
        `\`\`\`markdown\n[1](#stella-decision=${DEC_CZ_NS})\n> ${CZ_NS_TEXT}\n\`\`\``,
      ),
      load: codeOnlyLoader.load,
    });
    expect(codeOnlyOutcome).toEqual({ type: "no-quotations" });
    expect(codeOnlyLoader.requested).toEqual([]);

    const externalOnly = resolveLegalCitationLinks({
      url: "https://untrusted.example/law/cze/statutes/89-2012",
      sourceUrl: "https://www.e-sbirka.cz/sb/2012/89",
      appOrigins: APP_ORIGINS,
    });
    expect(externalOnly).toEqual({
      type: "external",
      url: "https://www.e-sbirka.cz/sb/2012/89",
    });
  });
});

// ---------------------------------------------------------------------------
// Part B — Promoted verify-quote-local.ts Real-Corpus Calibration Suite
// ---------------------------------------------------------------------------

describe("Part B: verifyQuote real-corpus calibration suite (promoted from evals/verify-quote-local.ts)", () => {
  const decisions = publicQuoteDecisions();

  it("calibrates every public court decision across all exact, typography, elision, altered, and fabricated scenarios", () => {
    expect(decisions.length).toBeGreaterThanOrEqual(5);

    const failures: {
      court: string;
      caseNumber: string;
      scenario: string;
      expected: string;
      actual: string;
      verified: boolean;
    }[] = [];

    let totalScenarios = 0;

    for (const [index, decision] of decisions.entries()) {
      const otherFulltext =
        decisions.at((index + 1) % decisions.length)?.fulltext ?? "";
      const scenarios = publicQuoteCases(decision.fulltext, otherFulltext);
      expect(scenarios.length).toBe(9);

      for (const scenario of scenarios) {
        totalScenarios += 1;
        const request = v.parse(verifyQuoteArgsSchema, {
          decision_id: "01990000-00a4-7000-8000-000000000001",
          text: scenario.quote,
        });
        const result = verifyQuote({
          text: decision.fulltext,
          quote: request.text,
          located: [],
          url: null,
        });
        v.parse(verifyQuoteOutputSchema, {
          decisionId: request.decision_id,
          textSource: "fulltext",
          ...result,
        });

        const pass =
          result.status === scenario.expected &&
          result.verified === (scenario.expected === "exact");
        if (!pass) {
          failures.push({
            court: decision.court,
            caseNumber: decision.case_number,
            scenario: scenario.name,
            expected: scenario.expected,
            actual: result.status,
            verified: result.verified,
          });
        }
      }
    }

    expect(totalScenarios).toBe(decisions.length * 9);
    expect(failures).toEqual([]);
  });

  it("rejects fabricated quotes on the large Constitutional Court benchmark (Pl. ÚS 19/08)", () => {
    const fulltext = largePublicQuoteDecision();
    expect(fulltext.length).toBeGreaterThan(50_000);

    const result = verifyQuote({
      text: fulltext,
      quote:
        "Soud jednomyslně dovodil, že automatizovaná analýza všech digitálních podkladů zakládá nevyvratitelnou domněnku oprávněnosti žalobního nároku bez dalšího dokazování.",
      located: [],
      url: null,
    });

    expect(result.status).toBe("not_found");
    expect(result.verified).toBe(false);
  });
});
