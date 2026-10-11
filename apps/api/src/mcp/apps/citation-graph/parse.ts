import * as v from "valibot";

import { READ_CASE_LAW_CITATIONS_PROJECTION } from "../../../lib/chat/projections";

export type CitationPage = v.InferOutput<
  typeof READ_CASE_LAW_CITATIONS_PROJECTION
>;

export const parseCitationPage = (payload: unknown) => {
  const parsed = v.safeParse(READ_CASE_LAW_CITATIONS_PROJECTION, payload);
  return parsed.success ? parsed.output : undefined;
};
