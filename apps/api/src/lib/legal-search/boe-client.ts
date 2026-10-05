import {
  findRelatedLaws,
  getBormeSummary,
  getConsolidatedLaw,
  getLawStructure,
  getLawTextBlock,
  searchConsolidatedLegislation,
} from "@stll/boe";

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

/**
 * The BOE open-data client, for a caller that holds a third-party outbound
 * permit. Nothing else in the API imports these calls from `@stll/boe`
 * (`third-party-outbound-permit.test.ts`), so the permit is the only way to
 * reach the BOE API.
 */
export const boeClient = (_permit: ThirdPartyOutboundPermit) =>
  ({
    findRelatedLaws,
    getBormeSummary,
    getConsolidatedLaw,
    getLawStructure,
    getLawTextBlock,
    searchConsolidatedLegislation,
  }) as const;
