import { caseLawSources } from "@/api/db/schema";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";

export {
  redistributableCaseLawSourceFor,
  redistributableCaseLawSourceSqlFor,
} from "@/api/lib/case-law/redistribution-sql";

export const redistributableCaseLawSource = redistributableCaseLawSourceFor(
  caseLawSources.descriptor,
);
