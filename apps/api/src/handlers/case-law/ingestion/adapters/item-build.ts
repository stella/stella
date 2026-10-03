import { panic } from "better-result";

import { classifyFailure } from "@stll/errors";

import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  PARSER_VERSIONS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const itemBuildFailed = failureSink({
  event: "case_law.ingestion.item_build_failed",
  expected: [],
});

type PlainTextItemOptions<T> = {
  adapterKey: AdapterKey;
  rawListing: string;
  build: () => Promise<T>;
  decisionOf: (value: T) => IngestionResult | undefined;
};

type PlainTextItemOutcome<T> =
  | { type: "built"; value: T }
  | { type: "item_build_failed"; decision: IngestionResult; value: T };

/** Source assembly keeps rejected raw; the page records its explicit item outcome. */
export const buildPlainTextItem = async <T>({
  adapterKey,
  rawListing,
  build,
  decisionOf,
}: PlainTextItemOptions<T>): Promise<PlainTextItemOutcome<T>> => {
  const value = await build();
  const decision = decisionOf(value);
  if (decision === undefined) {
    return { type: "built", value };
  }
  switch (decision.plainTextOutcome.type) {
    case "accepted":
      return { type: "built", value };
    case "item_build_failed":
      break;
    default:
      decision.plainTextOutcome satisfies never;
      return panic("Unhandled plain-text item outcome");
  }
  observeFailure(
    classifyFailure(decision.plainTextOutcome.error, "response_invalid"),
    {
      sink: itemBuildFailed,
      ctx: {
        adapterKey,
        ...(decision.sourceDocumentId === undefined
          ? {}
          : { documentId: decision.sourceDocumentId }),
      },
    },
  );
  const hasSourceRaw =
    decision.sourceRaw !== undefined ||
    decision.sourceRawBytes !== undefined ||
    (decision.sourceRawObjects !== undefined &&
      Object.keys(decision.sourceRawObjects).length > 0);
  const parserVersion = decision.parserVersion ?? PARSER_VERSIONS[adapterKey];
  return {
    type: "item_build_failed",
    value,
    decision: {
      ...decision,
      ...(hasSourceRaw
        ? {}
        : {
            sourceRaw: encodeSourceRawEnvelope({ listing: rawListing }),
            sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
          }),
      parserVersion,
    },
  };
};
