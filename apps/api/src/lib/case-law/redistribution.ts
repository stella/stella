import { caseLawSources } from "@/api/db/schema";
import {
  derivedAiCaseLawSourceFor,
  redistributableCaseLawSourceFor,
} from "@/api/lib/case-law/redistribution-sql";

export {
  redistributableCaseLawSourceFor,
  redistributableCaseLawSourceSqlFor,
} from "@/api/lib/case-law/redistribution-sql";

export const redistributableCaseLawSource = redistributableCaseLawSourceFor(
  caseLawSources.descriptor,
);

export const derivedAiCaseLawSource = derivedAiCaseLawSourceFor(
  caseLawSources.descriptor,
);
