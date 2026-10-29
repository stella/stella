import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import {
  caseFileNextPageHref,
  isCurrentCaseFileDocument,
} from "@/routes/law/-components/public-decision-case-file.logic";

const decisionId = (id: string) => toSafeId<"caseLawDecision">(id);

const DECISION = {
  id: decisionId("judgment-en"),
  languageGroupKey: "C-673/17",
};

describe("case-file documents", () => {
  test("the open decision and its translations are current; other documents are not", () => {
    expect(
      isCurrentCaseFileDocument(
        { id: decisionId("judgment-en"), languageGroupKey: null },
        DECISION,
      ),
    ).toBe(true);
    expect(
      isCurrentCaseFileDocument(
        { id: decisionId("judgment-cs"), languageGroupKey: "C-673/17" },
        DECISION,
      ),
    ).toBe(true);
    expect(
      isCurrentCaseFileDocument(
        { id: decisionId("opinion-en"), languageGroupKey: "C-673/17-opinion" },
        DECISION,
      ),
    ).toBe(false);
  });

  test("a document without a language group is current only by its own id", () => {
    expect(
      isCurrentCaseFileDocument(
        { id: decisionId("order-de"), languageGroupKey: null },
        { id: decisionId("judgment-de"), languageGroupKey: null },
      ),
    ).toBe(false);
  });

  test("the next page keeps the path, other parameters and the fragment", () => {
    expect(
      caseFileNextPageHref(
        {
          pathname: "/law/eu/cases/c-673-17",
          search: "?q=cookies&caseFileCursor=old",
          hash: "p-12",
        },
        "next+cursor/2",
      ),
    ).toBe(
      "/law/eu/cases/c-673-17?q=cookies&caseFileCursor=next%2Bcursor%2F2#p-12",
    );
    expect(
      caseFileNextPageHref(
        { pathname: "/law/eu/cases/c-673-17", search: "", hash: "" },
        "c2",
      ),
    ).toBe("/law/eu/cases/c-673-17?caseFileCursor=c2");
  });
});
