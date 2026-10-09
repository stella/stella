import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  APP_READER_TEXT,
  type AppReaderText,
  SOURCE_APP_READER_TEXT,
} from "@/api/lib/legal-search/adapter-manifest";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const UNKNOWN_READER_SOURCE_SINK = failureSink({
  event: "case_law.app_reader_source_unregistered",
  expected: [],
});

const isRegisteredSourceKey = (
  value: string,
): value is keyof typeof SOURCE_APP_READER_TEXT =>
  Object.hasOwn(SOURCE_APP_READER_TEXT, value);

/**
 * The in-app reader text setting for the source a decision was ingested under.
 *
 * A key the registry does not hold is a defect, so it is reported and read as
 * `metadata-only`: an unknown source never widens what the reader shows.
 */
export const appReaderTextForSource = (adapterKey: string): AppReaderText => {
  if (isRegisteredSourceKey(adapterKey)) {
    return SOURCE_APP_READER_TEXT[adapterKey];
  }
  observeFailure(
    new DatabaseError({
      message: "Case-law source names an unregistered adapter key",
    }),
    {
      sink: UNKNOWN_READER_SOURCE_SINK,
      ctx: { source: "case-law-app-reader-text", adapterKey },
    },
  );
  return APP_READER_TEXT.METADATA_ONLY;
};
