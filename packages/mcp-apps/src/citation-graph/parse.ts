import * as v from "valibot";

import { APP_CITATION_PAGE_SCHEMA } from "../shared/generated/contracts";
import type { CitationPage } from "../shared/generated/contracts";

export type { CitationPage };

export const parseCitationPage = (payload: unknown) => {
  const parsed = v.safeParse(APP_CITATION_PAGE_SCHEMA, payload);
  return parsed.success ? parsed.output : undefined;
};
