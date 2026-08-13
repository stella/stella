import { TaggedError } from "better-result";

import type { OutlookIngestionDiagnostic } from "@stll/api-contract";
import type { SafeId } from "@stll/api/types";

export type IngestEmailResult = {
  attachmentCount: number;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  skippedAttachments: string[];
  workspaceId: SafeId<"workspace">;
};

type PendingEmailUploadIdentity = {
  diagnostic: OutlookIngestionDiagnostic;
  sourceItemInstanceKey: string;
  uploadId: SafeId<"pendingUpload">;
  workspaceId: SafeId<"workspace">;
};

export type ReservedEmailUpload = PendingEmailUploadIdentity & {
  eml: File;
  headers: Record<string, string>;
  skippedAttachments: string[];
  type: "reserved";
  url: string;
};

export type UploadingEmailUpload = Omit<ReservedEmailUpload, "type"> & {
  type: "uploading";
};

export type FinalizingEmailUpload = PendingEmailUploadIdentity & {
  skippedAttachments: string[];
  type: "finalizing";
};

export type AbortingEmailUpload = PendingEmailUploadIdentity & {
  type: "aborting";
};

export type PendingEmailUpload =
  | AbortingEmailUpload
  | FinalizingEmailUpload
  | ReservedEmailUpload
  | UploadingEmailUpload;

export type IngestState =
  | { type: "idle" }
  | { diagnostic: OutlookIngestionDiagnostic; type: "downloading" }
  | PendingEmailUpload
  | (IngestEmailResult & {
      diagnostic: OutlookIngestionDiagnostic;
      type: "complete";
    })
  | {
      diagnostic: OutlookIngestionDiagnostic;
      message: string;
      pendingUpload: PendingEmailUpload | null;
      type: "error";
    };

export type IngestStateType = IngestState["type"];

const states = (...types: IngestStateType[]): readonly IngestStateType[] =>
  types;

const ALLOWED_INGEST_TRANSITIONS = {
  idle: states(
    "downloading",
    "reserved",
    "uploading",
    "finalizing",
    "aborting",
    "complete",
    "error",
  ),
  downloading: states("downloading", "reserved", "error"),
  reserved: states("reserved", "uploading", "finalizing", "aborting", "error"),
  uploading: states("uploading", "finalizing", "aborting", "error"),
  finalizing: states("finalizing", "aborting", "complete", "error"),
  aborting: states("aborting", "downloading", "complete", "error"),
  complete: states("idle"),
  error: states(
    "idle",
    "downloading",
    "reserved",
    "uploading",
    "finalizing",
    "aborting",
    "complete",
    "error",
  ),
} as const satisfies Record<IngestStateType, readonly IngestStateType[]>;

export class InvalidIngestTransitionError extends TaggedError(
  "InvalidIngestTransitionError",
)<{
  from: IngestStateType;
  message: string;
  to: IngestStateType;
}> {}

export const transitionIngestState = (
  current: IngestState,
  next: IngestState,
): IngestState => {
  const allowed: readonly IngestStateType[] =
    ALLOWED_INGEST_TRANSITIONS[current.type];
  if (allowed.includes(next.type)) {
    return next;
  }
  throw new InvalidIngestTransitionError({
    from: current.type,
    message: `Invalid Outlook ingestion transition: ${current.type} -> ${next.type}`,
    to: next.type,
  });
};

const ACTIVE_INGEST_STATES = {
  aborting: true,
  complete: false,
  downloading: true,
  error: false,
  finalizing: true,
  idle: false,
  reserved: true,
  uploading: true,
} as const satisfies Record<IngestStateType, boolean>;

export const isIngestActive = (state: IngestState): boolean =>
  ACTIVE_INGEST_STATES[state.type];

export const ingestTransitionTargets = (
  type: IngestStateType,
): readonly IngestStateType[] => ALLOWED_INGEST_TRANSITIONS[type];

export const isLatestSnapshotForSave = ({
  initialItemInstanceKey,
  latestIsCurrent,
  latestItemInstanceKey,
}: {
  initialItemInstanceKey: string;
  latestIsCurrent: boolean;
  latestItemInstanceKey: string;
}): boolean =>
  latestIsCurrent && latestItemInstanceKey === initialItemInstanceKey;

export const pendingUploadMatchesSnapshot = (
  pending: { sourceItemInstanceKey: string },
  itemInstanceKey: string,
): boolean => pending.sourceItemInstanceKey === itemInstanceKey;
