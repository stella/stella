import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_OCR_AVAILABILITY_REFRESH_MS,
  documentOcrAvailabilityKeys,
  documentOcrAvailabilityOptions,
} from "@/queries/document-ocr-availability";

describe("documentOcrAvailabilityOptions", () => {
  test("refreshes mounted OCR controls before the readiness lease expires", () => {
    const organizationId = "organization_test";
    const options = documentOcrAvailabilityOptions({ organizationId });

    expect(options.queryKey).toEqual(
      documentOcrAvailabilityKeys.byOrganization({ organizationId }),
    );
    expect(options.refetchInterval).toBe(DOCUMENT_OCR_AVAILABILITY_REFRESH_MS);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.staleTime).toBe(DOCUMENT_OCR_AVAILABILITY_REFRESH_MS);
    expect(DOCUMENT_OCR_AVAILABILITY_REFRESH_MS).toBeLessThan(90_000);
  });
});
