import type { BoundingBoxes } from "@/api/db/schema-validators";

export type LegalListSourceLocator =
  | { type: "document" }
  | { type: "docx-block"; blockId: string }
  | {
      type: "pdf-page";
      pageNumber: number;
      boundingBoxes?: BoundingBoxes | undefined;
    };
