import type { SafeId } from "@/api/lib/branded-types";

export const contactExtractionUploadKey = ({
  organizationId,
  uploadId,
}: {
  organizationId: SafeId<"organization">;
  uploadId: SafeId<"contactExtractionUpload">;
}): string => `${organizationId}/contact-extractions/tmp/${uploadId}`;
