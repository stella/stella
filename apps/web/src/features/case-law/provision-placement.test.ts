import { expect, test } from "bun:test";

import { resolveProvisionDocument } from "@/features/case-law/provision-placement";
import type { ResolvedCitedStatute } from "@/features/case-law/queries/provisions";

const statute = {
  id: "statute-1",
  country: "CZE",
  eli: "/eli/cz/89/2012",
  slug: null,
  title: "Act",
  language: "cs",
  versionValidFrom: "2014-01-01",
  versionValidTo: null,
  expressionKind: "consolidation",
  windowDisposition: "effective",
} as const satisfies ResolvedCitedStatute;

test("every unavailable stored target yields a typed outcome while loading stays pending", () => {
  const base = {
    row: { workEli: statute.eli, versionValidFrom: "2014-01-01" },
    statute,
    versions: [],
    statuteState: "settled",
    versionsState: "settled",
  } as const;
  expect(resolveProvisionDocument(base)).toEqual({
    status: "placed",
    document: statute,
  });
  expect(
    resolveProvisionDocument({ ...base, row: { ...base.row, workEli: null } }),
  ).toEqual({
    status: "unplaced",
    reason: "work-unresolved",
  });
  expect(resolveProvisionDocument({ ...base, statute: undefined })).toEqual({
    status: "unplaced",
    reason: "statute-not-loaded",
  });
  expect(
    resolveProvisionDocument({
      ...base,
      statute: undefined,
      statuteState: "loading",
    }),
  ).toEqual({
    status: "pending",
    reason: "statute-not-loaded",
  });
  const olderRow = { ...base.row, versionValidFrom: "2013-01-01" };
  expect(resolveProvisionDocument({ ...base, row: olderRow })).toEqual({
    status: "unplaced",
    reason: "no-version-in-force",
  });
  expect(
    resolveProvisionDocument({
      ...base,
      row: olderRow,
      versionsState: "loading",
    }),
  ).toEqual({
    status: "pending",
    reason: "no-version-in-force",
  });
  const older = {
    ...statute,
    id: "statute-0",
    versionValidFrom: "2010-01-01",
    versionValidTo: "2014-01-01",
  };
  expect(
    resolveProvisionDocument({ ...base, row: olderRow, versions: [older] }),
  ).toEqual({
    status: "placed",
    document: older,
  });
});
