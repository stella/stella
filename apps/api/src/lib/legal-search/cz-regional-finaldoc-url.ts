import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

const CZ_REGIONAL_ORIGIN = "https://rozhodnuti.justice.cz";
const CZ_REGIONAL_FINALDOC_PATH = "/api/finaldoc/";

export const restrictCzRegionalFinaldocUrl = (rawUrl: string): URL | null =>
  restrictOutboundUrl({
    rawUrl,
    hostPolicy: {
      type: "exact-origin",
      origins: [CZ_REGIONAL_ORIGIN],
    },
    pathPrefixes: [CZ_REGIONAL_FINALDOC_PATH],
  });
