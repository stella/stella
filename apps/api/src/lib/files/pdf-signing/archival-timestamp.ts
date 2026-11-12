/**
 * The archival document timestamp that takes a B-LT signature to B-LTA
 * (ETSI EN 319 142-1 5.5).
 *
 * Once the signature and its validation data are embedded, one more
 * incremental update adds a `/DocTimeStamp` signature (SubFilter
 * ETSI.RFC3161, ISO 32000-2 12.8.5) whose byte range covers everything
 * before it: the signature, its timestamp and the Document Security Store.
 * A later validator can then rely on that data even after the certificates
 * it vouches for have expired or their algorithms weakened. LibPDF places
 * the timestamp; its own validation-data gathering stays off for the same
 * reason as for the signature (see `validation-data.ts`), and the
 * timestamp's chain and revocation data go through the guarded fetchers
 * and stella's own store writer instead.
 *
 * The step is best effort. The signature it extends is already complete,
 * so every failure, including running out of time, leaves the B-LT bytes as
 * they were and only says why in a warning.
 */

import { PDF } from "@libpdf/core";
import { Result } from "better-result";

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { TrackedRevocationProvider } from "@/api/lib/files/pdf-signing/revocation";
import { assessTimestamp } from "@/api/lib/files/pdf-signing/timestamp-assessment";
import { createFallbackTimestampAuthority } from "@/api/lib/files/pdf-signing/timestamp-authority";
import type { NamedTimestampAuthority } from "@/api/lib/files/pdf-signing/timestamp-authority";
import type { TimestampTrust } from "@/api/lib/files/pdf-signing/timestamp-trust";
import {
  embedValidationData,
  gatherArchivalValidationData,
  hasValidationMaterial,
} from "@/api/lib/files/pdf-signing/validation-data";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * Bytes reserved for the document timestamp's token: at least what the
 * signature's own token reservation allows, and more when the signature's
 * token was larger. A fallback authority's token may differ in size; one
 * that does not fit costs only the archival timestamp.
 */
const ARCHIVE_TOKEN_FLOOR_BYTES = 16_384;
const ARCHIVE_TOKEN_HEADROOM_BYTES = 4096;
const ARCHIVE_TOKEN_GRANULARITY_BYTES = 1024;
/** Below this, a TSA round trip and its chain checks are not worth starting. */
const ARCHIVE_MIN_TIMEOUT_MS = 3000;

export const archivalTimestampSize = (signatureTokenBytes: number) =>
  Math.max(
    ARCHIVE_TOKEN_FLOOR_BYTES,
    Math.ceil(
      (signatureTokenBytes + ARCHIVE_TOKEN_HEADROOM_BYTES) /
        ARCHIVE_TOKEN_GRANULARITY_BYTES,
    ) * ARCHIVE_TOKEN_GRANULARITY_BYTES,
  );

type ArchivalWarning = { code: string; message: string };

export type ArchivalOutcome =
  /** The timestamp and its validation data are in; the signature is B-LTA. */
  | { status: "archived"; bytes: Uint8Array; warnings: ArchivalWarning[] }
  /**
   * Something fell short. `bytes` is the B-LT input, or the input plus a
   * document timestamp that could not be relied on long term; either way
   * the signature still validates as B-LT.
   */
  | { status: "not-archived"; bytes: Uint8Array; warnings: ArchivalWarning[] };

type AddArchivalTimestampOptions = {
  /** The B-LT document: signature, timestamp and store embedded. */
  bytes: Uint8Array;
  /** Certificates the store in `bytes` already holds. */
  embeddedCertificates: readonly Uint8Array[];
  permit: ThirdPartyOutboundPermit;
  provider: TrackedRevocationProvider;
  /** Size of the signature's timestamp token, to size this one's room. */
  signatureTokenBytes: number;
  timestampAuthorities: readonly NamedTimestampAuthority[];
  timeoutMs: number;
  trust: TimestampTrust;
};

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const notArchived = (
  bytes: Uint8Array,
  code: string,
  message: string,
): ArchivalOutcome => ({
  status: "not-archived",
  bytes,
  warnings: [{ code, message }],
});

const archive = async ({
  bytes,
  embeddedCertificates,
  permit,
  provider,
  signatureTokenBytes,
  timestampAuthorities,
  trust,
}: AddArchivalTimestampOptions): Promise<ArchivalOutcome> => {
  // A fresh fallback: what it records must be the archival token, never
  // the signature's.
  const authority = createFallbackTimestampAuthority(timestampAuthorities);
  const placed = await Result.tryPromise(async () => {
    const pdf = await PDF.load(bytes);
    const { bytes: timestamped } = await pdf.addTimestamp({
      timestampAuthority: authority,
      digestAlgorithm: "SHA-256",
      estimatedSize: archivalTimestampSize(signatureTokenBytes),
      longTermValidation: false,
    });
    return { pdf, timestamped };
  });
  const token = authority.used();
  if (Result.isError(placed) || token === null) {
    return notArchived(
      bytes,
      "ARCHIVE_TIMESTAMP_UNAVAILABLE",
      Result.isError(placed)
        ? describeError(placed.error.cause)
        : "No timestamp authority issued the archival timestamp.",
    );
  }
  const { pdf, timestamped } = placed.value;

  const assessed = await assessTimestamp({ permit, timestamp: token, trust });
  // As for the signature's timestamp, trust is reported, not required.
  const warnings: ArchivalWarning[] = assessed.trusted
    ? []
    : [
        {
          code: "ARCHIVE_TIMESTAMP_UNTRUSTED",
          message:
            "The archival timestamp authority's chain reaches no trust anchor; validators that do not trust it will not rely on its time.",
        },
      ];
  /** Fell short after the timestamp was placed: keep it, say why. */
  const fellShort = (code: string, message: string): ArchivalOutcome => ({
    status: "not-archived",
    bytes: timestamped,
    warnings: [...warnings, { code, message }],
  });
  if (!assessed.complete) {
    return fellShort(
      "ARCHIVE_TIMESTAMP_CHAIN_INCOMPLETE",
      "The archival timestamp authority's certificate chain does not reach a root certificate.",
    );
  }
  const validation = await gatherArchivalValidationData({
    embeddedCertificates,
    provider,
    timestampChain: assessed.chain,
  });
  if (validation.uncovered.length > 0) {
    return fellShort(
      "ARCHIVE_REVOCATION_UNAVAILABLE",
      `No revocation data for ${validation.uncovered.length} certificate(s) in the archival timestamp authority's chain.`,
    );
  }
  if (!hasValidationMaterial(validation.material)) {
    return { status: "archived", bytes: timestamped, warnings };
  }
  // `addTimestamp` reloaded `pdf` with the timestamped bytes, so the store
  // lands in one more update after them.
  const embedded = await embedValidationData(pdf, validation.material);
  return Result.isError(embedded)
    ? fellShort("ARCHIVE_REVOCATION_UNAVAILABLE", embedded.error.message)
    : { status: "archived", bytes: embedded.value, warnings };
};

/**
 * Seal a B-LT document with an archival document timestamp within
 * `timeoutMs`. Never fails: an outcome that is not `archived` carries the
 * bytes to keep and the reason.
 */
export const addArchivalTimestamp = async (
  options: AddArchivalTimestampOptions,
): Promise<ArchivalOutcome> => {
  if (options.timeoutMs < ARCHIVE_MIN_TIMEOUT_MS) {
    return notArchived(
      options.bytes,
      "ARCHIVE_TIMESTAMP_UNAVAILABLE",
      "No time was left for the archival timestamp.",
    );
  }
  const outcome = await Result.tryPromise({
    try: async () =>
      await withTimeout(async () => await archive(options), {
        label: "pdf-signing.archival-timestamp",
        timeoutMs: options.timeoutMs,
      }),
    catch: (cause) => cause,
  });
  return Result.isError(outcome)
    ? notArchived(
        options.bytes,
        "ARCHIVE_TIMESTAMP_UNAVAILABLE",
        describeError(outcome.error),
      )
    : outcome.value;
};
