import * as v from "valibot";

import { decisionBodySourceSchema } from "@stll/api-contract/case-law-body-source";

import {
  CHAT_PROJECTION_METADATA_KEY,
  projectionBranch,
} from "./projection-fields";

const [hostBody, collectionBody] =
  decisionBodySourceSchema.options satisfies readonly [
    v.GenericSchema,
    v.GenericSchema,
  ];

/** Publication IDs and URLs stay public handles; the wire shape is canonical. */
export const decisionBodySourceProjection = v.variant("textSource", [
  projectionBranch(hostBody),
  projectionBranch(
    v.strictObject({
      ...collectionBody.entries,
      source: v.strictObject({
        ...collectionBody.entries.source.entries,
        id: v.pipe(
          collectionBody.entries.source.entries.id,
          v.metadata({
            [CHAT_PROJECTION_METADATA_KEY]: { role: "passthroughId" },
          }),
        ),
      }),
      sourceUrl: v.pipe(
        collectionBody.entries.sourceUrl,
        v.metadata({
          [CHAT_PROJECTION_METADATA_KEY]: { role: "publicUrl" },
        }),
      ),
    }),
  ),
]);
