import { describe, expect, test } from "bun:test";

import { toChatDecisionPassageHref } from "@stll/api-contract";
import { toSafeId } from "@stll/api-contract/safe-id";

import { groupSourceChips } from "@/components/chat/source-chip-groups.logic";
import type { ExternalSourceEntry } from "@/components/chat/source-chips.logic";

const DECISION_ID = "0196f3b2-6a1e-7c3d-9f4b-1a2b3c4d5e6f";
const READER =
  "https://app.example/law/cze/cases/nejvyssi-soud/21-cdo-4733-2015";
const PUBLISHER = "https://nsoud.example/21-cdo-4733-2015";
const ACT = "https://app.example/law/cze/statutes/zakonik-prace";

const decision: ExternalSourceEntry = {
  appUrl: READER,
  sourceUrl: PUBLISHER,
  url: READER,
  title: "21 Cdo 4733/2015",
  caseLawDecision: {
    caseNumber: "21 Cdo 4733/2015",
    decisionId: DECISION_ID,
    citation: {
      court: "Nejvyšší soud",
      courtShortCode: "NS",
      decisionDate: "2017-02-01",
    },
  },
};

const paragraph = (anchor: string, title: string): ExternalSourceEntry => ({
  url: `${READER}#${anchor}`,
  title,
});

describe("source chip groups", () => {
  test("every passage of one decision is one chip labelled by court and docket", () => {
    const groups = groupSourceChips({
      answerTexts: [],
      sources: [
        paragraph("p-3", "12."),
        decision,
        paragraph("p-7", "Odůvodnění"),
        paragraph("p-9", "https://app.example"),
      ],
    });

    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.type).toBe("decision");
    if (group?.type !== "decision") {
      return;
    }
    expect(group.label).toBe("NS 21 Cdo 4733/2015");
    expect(group.court).toBe("Nejvyšší soud");
    expect(group.decisionDate).toBe("2017-02-01");
    expect(group.source.url).toBe(READER);
    expect(group.source.sourceUrl).toBe(PUBLISHER);
    expect(group.parts).toEqual([
      {
        anchorId: "p-3",
        label: { type: "text", text: "12." },
        url: `${READER}#p-3`,
      },
      {
        anchorId: "p-7",
        label: { type: "text", text: "Odůvodnění" },
        url: `${READER}#p-7`,
      },
      { anchorId: "p-9", label: { type: "unnamed" }, url: `${READER}#p-9` },
    ]);
  });

  test("a heading is only ever a part's label, never the chip's", () => {
    const groups = groupSourceChips({
      answerTexts: [],
      sources: [paragraph("p-7", "II. Posouzení dovolání"), decision],
    });
    expect(
      groups.map((group) => group.type === "decision" && group.label),
    ).toEqual(["NS 21 Cdo 4733/2015"]);
  });

  test("the court's paragraph number from the answer's passage link labels the part", () => {
    const href = toChatDecisionPassageHref({
      anchorId: "p-3",
      courtParagraphNumber: 12,
      decisionId: toSafeId<"caseLawDecision">(DECISION_ID),
    });
    const [group] = groupSourceChips({
      answerTexts: [`Soud uvedl [toto](${href}).`],
      sources: [decision, paragraph("p-3", "12.")],
    });
    expect(group?.type === "decision" && group.parts).toEqual([
      {
        anchorId: "p-3",
        label: { type: "paragraph", number: 12 },
        url: `${READER}#p-3`,
      },
    ]);
  });

  test("provisions of one act are one chip; unrelated sources keep their own", () => {
    const groups = groupSourceChips({
      answerTexts: [],
      sources: [
        { url: `${ACT}#par_52`, title: "§ 52" },
        { url: ACT, title: "Zákoník práce" },
        { url: `${ACT}#par_55`, title: "§ 55" },
        { url: "https://example.test/article", title: "Article" },
      ],
    });
    expect(groups.map((group) => group.type)).toEqual(["statute", "source"]);
    const [act] = groups;
    expect(act?.type === "statute" && act.label).toBe("Zákoník práce");
    expect(
      act?.type === "statute" && act.parts.map(({ anchorId }) => anchorId),
    ).toEqual(["par_52", "par_55"]);
  });
});
