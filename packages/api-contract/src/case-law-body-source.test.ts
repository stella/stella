import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  decisionBodySourceSchema,
  linklessDecisionBodySourceSchema,
  withoutCollectionLinks,
} from "./case-law-body-source";

const collection = {
  id: "af6c7d89-41ab-42ba-814e-b657703584ed",
  name: "Test collection",
  adapterKey: "test-collection",
  allowsDerivedAi: true,
};
const publication = {
  source: collection,
  sourceDocumentId: "post-1",
  sourceUrl: "https://example.test/collection/post-1",
  retrievedAt: null,
  contribution: "body",
} as const;
const bodySource = v.parse(decisionBodySourceSchema, {
  textSource: "collection",
  source: collection,
  sourceUrl: "https://example.test/collection",
  retrievedAt: "2026-01-01T00:00:00.000Z",
  extent: "section",
  provenance: {
    coverage: "truncated",
    totalCount: 4,
    omittedCount: 1,
    records: [
      { extent: "complete", ...publication },
      {
        extent: "section",
        sectionNumber: 2,
        collectionLabel: "II.",
        ...publication,
      },
      { extent: "unclassified", ...publication },
    ],
  },
});

test("linkless attribution keeps every field but the publication URLs", () => {
  const linkless = withoutCollectionLinks(bodySource);
  expect(v.parse(linklessDecisionBodySourceSchema, linkless)).toEqual(linkless);
  expect(JSON.stringify(linkless)).not.toContain('"sourceUrl"');
  expect(JSON.stringify(linkless)).toBe(
    JSON.stringify(bodySource, (key, value: unknown) =>
      key === "sourceUrl" ? undefined : value,
    ),
  );
});

test("linkless attribution refuses a publication URL", () => {
  expect(v.is(linklessDecisionBodySourceSchema, bodySource)).toBe(false);
});

test("a host body source has no links to drop", () => {
  const host = { textSource: "host" } as const;
  expect(withoutCollectionLinks(host)).toEqual(host);
});
