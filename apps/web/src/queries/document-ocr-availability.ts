import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";

// The worker readiness lease expires after 90 seconds. Refresh a mounted OCR
// control before that, but never poll while its tab is in the background.
export const DOCUMENT_OCR_AVAILABILITY_REFRESH_MS = 60_000;

type DocumentOcrAvailabilityKey = {
  organizationId: string;
};

export const documentOcrAvailabilityKeys = {
  all: ["document-ocr-availability"] as const,
  byOrganization: ({ organizationId }: DocumentOcrAvailabilityKey) => [
    ...documentOcrAvailabilityKeys.all,
    organizationId,
  ],
};

export const documentOcrAvailabilityOptions = ({
  organizationId,
}: DocumentOcrAvailabilityKey) =>
  queryOptions({
    queryKey: documentOcrAvailabilityKeys.byOrganization({ organizationId }),
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api["organization-settings"]["document-ocr-availability"].get({
          fetch: { signal },
        }),
      ),
    refetchInterval: DOCUMENT_OCR_AVAILABILITY_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: DOCUMENT_OCR_AVAILABILITY_REFRESH_MS,
  });
