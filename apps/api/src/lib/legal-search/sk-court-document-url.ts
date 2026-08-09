import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

const SK_COURT_DOCUMENT_ORIGIN = "https://obcan.justice.sk";
const SK_COURT_DOCUMENT_PATH = "/content/public/item/";

export const restrictSkCourtDocumentUrl = (rawUrl: string): URL | null =>
  restrictOutboundUrl({
    rawUrl,
    hostPolicy: {
      type: "exact-origin",
      origins: [SK_COURT_DOCUMENT_ORIGIN],
    },
    pathPrefixes: [SK_COURT_DOCUMENT_PATH],
  });
