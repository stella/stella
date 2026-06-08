import { APIError } from "@/lib/errors";

export type StorageFetchPurpose = "display" | "download" | "native-display";

type FetchStorageArrayBufferOptions = {
  signal: AbortSignal;
  purpose: StorageFetchPurpose;
};

type StorageFetchPhase = "response" | "body";

type StorageNetworkErrorOptions = {
  error: unknown;
  phase: StorageFetchPhase;
  purpose: StorageFetchPurpose;
};

// Direct presigned URL fetches fail without an HTTP response for CORS,
// TLS, DNS, offline, and content-blocker cases. Keep those failures
// network-shaped for the route boundary while recording the storage phase.
export const fetchStorageArrayBuffer = async (
  presignedUrl: string,
  { signal, purpose }: FetchStorageArrayBufferOptions,
) => {
  let response: Response;
  try {
    response = await fetch(presignedUrl, { signal });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    throw toStorageNetworkError({ error, phase: "response", purpose });
  }

  if (!response.ok) {
    throw new APIError({
      status: response.status,
      message: `Failed to fetch file from storage (purpose=${purpose})`,
      details: { phase: "response", purpose },
    });
  }

  try {
    return await response.arrayBuffer();
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }

    throw toStorageNetworkError({ error, phase: "body", purpose });
  }
};

const toStorageNetworkError = ({
  error,
  phase,
  purpose,
}: StorageNetworkErrorOptions) =>
  new APIError({
    status: 0,
    message:
      phase === "response"
        ? `Storage fetch failed before response (purpose=${purpose})`
        : `Storage response body read failed (purpose=${purpose})`,
    details: {
      causeType: getCauseType(error),
      phase,
      purpose,
    },
  });

const getCauseType = (error: unknown): string => {
  if (error instanceof Error) {
    return error.name;
  }

  if (error === null) {
    return "null";
  }

  return typeof error;
};
