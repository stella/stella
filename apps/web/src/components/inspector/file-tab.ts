import type { FileFacet } from "@stll/api-contract/inspector-file-facet";

export type FileTab = {
  type: "pdf";
  id: string;
  renderId?: string | undefined;
  entityId: string;
  label: string;
  fileName: string;
  mimeType?: string | undefined;
  pdfFileId: string | null;
  workspaceId: string;
  justificationFieldId?: string | undefined;
  propertyId?: string | undefined;
  metadataLane?: "closed" | "expanded" | undefined;
  facet?: FileFacet | undefined;
  facetPulseSeq?: number | undefined;
};
