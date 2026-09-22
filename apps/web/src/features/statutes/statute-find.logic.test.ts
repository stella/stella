import { describe, expect, test } from "bun:test";

import { findTableRows } from "@/components/workspaces/table/table-find.logic";
import type { StatuteListItem } from "@/features/statutes/queries/statutes";
import { STATUTE_COLUMN_IDS } from "@/features/statutes/statute-columns.logic";
import {
  isFindableStatuteColumn,
  statuteFindRowText,
} from "@/features/statutes/statute-find.logic";
import { toSafeId } from "@/lib/safe-id";

const statute = (
  overrides: Pick<StatuteListItem, "documentType" | "eli" | "title">,
): StatuteListItem => ({
  amendmentCount: 18,
  citationCaseCount: null,
  country: "CZE",
  documentUrl: null,
  effectiveDate: "2026-01-01",
  firstVersionValidFrom: "2012-03-22",
  id: toSafeId<"legislationDocument">(crypto.randomUUID()),
  language: "cs",
  lastAmendedOn: "2026-01-01",
  slug: null,
  sourceUrl: null,
  status: "current",
  validity: "in-force",
  versionValidFrom: "2026-01-01",
  versionValidTo: null,
  ...overrides,
});

const CIVIL_CODE = statute({
  documentType: "zákon",
  eli: "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
  title: "89/2012 Sb., občanský zákoník",
});
const DECREE = statute({
  documentType: "vyhláška",
  eli: "https://www.e-sbirka.cz/eli/cz/sb/2013/90",
  title: "90/2013 Sb., o evidenci",
});

describe("what a statute row shows a find", () => {
  test("the act column reads both the number and the name the cell draws", () => {
    expect(statuteFindRowText(CIVIL_CODE).get("act")).toBe(
      "89/2012 Sb.\nobčanský zákoník",
    );
  });

  test("every column the picker offers as searchable has text, and no other does", () => {
    const text = statuteFindRowText(CIVIL_CODE);
    for (const column of STATUTE_COLUMN_IDS) {
      expect(text.has(column)).toBe(isFindableStatuteColumn(column));
    }
  });

  test("a find narrowed to the type keeps only the rows of that type", () => {
    expect(
      findTableRows({
        columnIds: ["type"],
        rows: [CIVIL_CODE, DECREE],
        rowText: statuteFindRowText,
        term: "vyhláška",
      }),
    ).toEqual([DECREE]);
  });
});
