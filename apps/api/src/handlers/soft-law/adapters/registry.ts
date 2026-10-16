import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import type {
  SoftLawAuthority,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";

import { edpbAdapter } from "./edpb";
import { wp29Adapter } from "./wp29";

type EuAuthority = Extract<SoftLawAuthority, `eu-${string}`>;
type SourceRegistration = {
  adapter: SoftLawSourceAdapter;
  descriptor: CorpusSourceDescriptor;
  reuseNotice: string;
};

/** These sources are ingestion-only; this registry confers no public-read permission. */
export const EU_SOFT_LAW_SOURCES = {
  "eu-edpb": {
    adapter: edpbAdapter,
    descriptor: {
      license: "permitted-redistribution",
      attribution:
        "European Data Protection Board; https://www.edpb.europa.eu/copyright_en",
      allowsRedistribution: false,
      allowsDerivedAi: false,
    },
    reuseNotice: "https://www.edpb.europa.eu/copyright_en",
  },
  "eu-wp29": {
    adapter: wp29Adapter,
    descriptor: {
      license: "restricted",
      attribution: "Article 29 Working Party; European Commission archive",
      allowsRedistribution: false,
      allowsDerivedAi: false,
    },
    reuseNotice: "https://commission.europa.eu/legal-notice_en",
  },
} as const satisfies Record<EuAuthority, SourceRegistration>;
