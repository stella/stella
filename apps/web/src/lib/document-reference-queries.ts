/**
 * Resolve the document reference an uploaded file carries.
 *
 * Split from `@/lib/document-reference` so the extractor stays importable (and
 * testable) without pulling in the API client.
 */
import type { QueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { Result } from "better-result";

import { mapWithConcurrency } from "@stll/concurrency";

import { api } from "@/lib/api";
import type { DocumentReferenceEvidence } from "@/lib/document-reference";
import {
  couldCarryDocumentReference,
  readDocumentReference,
} from "@/lib/document-reference";
import { shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";

const NOT_FOUND_STATUS = 404;

/**
 * A frozen reference names the same document for its lifetime; only
 * `currentVersionNumber` moves under it, and a stale-by-one warning does not
 * justify a refetch on every window focus.
 */
const DOCUMENT_REFERENCE_STALE_MS = 5 * 60 * 1000;

/**
 * Lookups run while the user waits on an upload dialog, so they are bounded
 * well below the upload budget: a dropped folder of a hundred stamped files
 * must not open a hundred connections before anything uploads.
 */
const MAX_PARALLEL_REFERENCE_LOOKUPS = 4;

export type DocumentReferenceMatch = {
  entityId: string;
  entityName: string | null;
  workspaceId: string;
  workspaceName: string;
  /** The reference frozen onto the matched version (`2026/001/015.v3`). */
  stamp: string;
  /** Version the file in hand was taken from. */
  versionNumber: number;
  /** Highest version the document has now; higher means the file is stale. */
  currentVersionNumber: number;
};

/**
 * The document a file's reference names, together with what the file still
 * carried that reference in. The evidence is the file's own, not the server's:
 * two files can resolve to the same document and still deserve different
 * offers, because only one of them kept its visible reference line.
 */
export type ResolvedDocumentReference = {
  match: DocumentReferenceMatch;
  evidence: DocumentReferenceEvidence;
};

/** A file that turned out to be a version of a document already in stella. */
export type ReferencedFile = ResolvedDocumentReference & {
  file: File;
};

export const documentReferenceKeys = {
  byCode: (verificationCode: string) =>
    ["document-reference", verificationCode] as const,
};

/**
 * Resolve a verification code to the document it names, or `null` when the
 * caller's organization owns no such reference.
 *
 * A miss is an ordinary answer rather than an error: verification codes travel
 * outside the product, so an unknown one simply means the upload is a new
 * document.
 */
export const documentReferenceOptions = (verificationCode: string) =>
  queryOptions({
    queryKey: documentReferenceKeys.byCode(verificationCode),
    staleTime: DOCUMENT_REFERENCE_STALE_MS,
    retry: shouldRetryAPIRequest,
    queryFn: async ({
      signal,
    }: {
      signal: AbortSignal;
    }): Promise<DocumentReferenceMatch | null> => {
      const response = await api
        .verify({ code: verificationCode })
        .get({ fetch: { signal } });

      if (response.error?.status === NOT_FOUND_STATUS) {
        return null;
      }
      return unwrapEden(response);
    },
  });

/**
 * Read one file's reference and resolve it. Answers `null` for every file that
 * carries none, whose reference belongs to another organization, or that
 * cannot be opened.
 */
export const resolveFileDocumentReference = async (
  queryClient: QueryClient,
  file: File,
): Promise<ResolvedDocumentReference | null> => {
  const reference = await readDocumentReference(file);
  if (reference === null) {
    return null;
  }
  const match = await queryClient.fetchQuery(
    documentReferenceOptions(reference.verificationCode),
  );
  return match === null ? null : { match, evidence: reference.evidence };
};

type ResolveDocumentReferenceMatchesOptions = {
  queryClient: QueryClient;
  files: readonly File[];
  /** Telemetry for a lookup that failed; the file still uploads as new. */
  onError: (error: Error) => void;
};

/**
 * Find which of these files are versions of documents already in stella.
 *
 * Non-DOCX files are filtered out before any archive is opened, so a batch of
 * scans or images pays nothing for this. A lookup that fails is reported and
 * treated as "no match": a network problem must not block an upload, it can
 * only cost the user the offer to file it as a version.
 */
export const resolveDocumentReferenceMatches = async ({
  queryClient,
  files,
  onError,
}: ResolveDocumentReferenceMatchesOptions): Promise<ReferencedFile[]> => {
  const candidates = files.filter(couldCarryDocumentReference);
  if (candidates.length === 0) {
    return [];
  }

  const resolved = await mapWithConcurrency({
    items: candidates,
    limit: MAX_PARALLEL_REFERENCE_LOOKUPS,
    operation: async (file): Promise<ReferencedFile | null> => {
      const result = await Result.tryPromise(
        async () => await resolveFileDocumentReference(queryClient, file),
      );
      if (Result.isError(result)) {
        onError(result.error);
        return null;
      }
      return result.value === null
        ? null
        : { file, match: result.value.match, evidence: result.value.evidence };
    },
  });

  return resolved.filter((entry) => entry !== null);
};
