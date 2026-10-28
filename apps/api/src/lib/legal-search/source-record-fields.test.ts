import { expect, test } from "bun:test";

import type { SourceRecordPaths } from "./source-record-fields";

type PublisherRecord = {
  id: string;
  court?: { name: string; location: { longitude: number } | null } | null;
  references: readonly { docket: string }[];
  keywords?: readonly string[] | null;
  raw?: unknown;
  attachments?: readonly unknown[];
};

const fields = {
  id: "stored",
  "court.name": "stored",
  "court.location.longitude": "stored",
  "references[].docket": "stored",
  keywords: "stored",
  raw: "stored",
  attachments: "stored",
} as const satisfies Record<SourceRecordPaths<PublisherRecord>, "stored">;

test("publisher fields require a disposition across nested records and arrays", () => {
  expect(Object.keys(fields)).toEqual([
    "id",
    "court.name",
    "court.location.longitude",
    "references[].docket",
    "keywords",
    "raw",
    "attachments",
  ]);

  const { id: _id, ...missingField } = fields;
  // @ts-expect-error Deleting a publisher field's disposition is rejected.
  missingField satisfies Record<SourceRecordPaths<PublisherRecord>, "stored">;

  // @ts-expect-error A publisher schema addition requires a disposition.
  fields satisfies Record<
    SourceRecordPaths<PublisherRecord & { publication: { date: string } }>,
    "stored"
  >;
});
