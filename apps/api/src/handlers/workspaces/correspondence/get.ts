import { panic, Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  CORRESPONDENCE_MAX_ATTACHMENTS,
  type CorrespondenceDataBoxContactMatches,
  type CorrespondenceDataBoxContacts,
} from "@stll/api-contract/correspondence";
import type { DataBoxEnvelope } from "@stll/api-contract/data-box";

import type { Transaction } from "@/api/db/root";
import {
  contacts,
  correspondence,
  correspondenceAllowedSenders,
  correspondenceAttachments,
  correspondenceFilers,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { readOrganizationDataBoxIds } from "@/api/lib/email/correspondence/data-box/organization-boxes";
import {
  readCorrespondenceChannel,
  readCorrespondenceProvenance,
} from "@/api/lib/email/correspondence/provenance";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type CorrespondenceRow = typeof correspondence.$inferSelect;

const CORRESPONDENCE_DETAIL_COLUMNS = {
  id: correspondence.id,
  direction: correspondence.direction,
  channel: correspondence.channel,
  source: correspondence.source,
  sourceEntityId: correspondence.sourceEntityId,
  intake: correspondence.intake,
  authenticatedSenderAddress: correspondence.authenticatedSenderAddress,
  originalSignature: correspondence.originalSignature,
  messageId: correspondence.messageId,
  dataBox: correspondence.dataBox,
  from: correspondence.from,
  to: correspondence.to,
  cc: correspondence.cc,
  subject: correspondence.subject,
  sentAt: correspondence.sentAt,
  receivedAt: correspondence.receivedAt,
  inReplyTo: correspondence.inReplyTo,
  references: correspondence.references,
  bodyText: correspondence.bodyText,
  bodyHtml: correspondence.bodyHtml,
  spf: correspondence.spf,
  dkim: correspondence.dkim,
  dmarc: correspondence.dmarc,
  alignedIdentifier: correspondence.alignedIdentifier,
  handlingState: correspondence.handlingState,
  assigneeId: correspondence.assigneeId,
  createdAt: correspondence.createdAt,
  updatedAt: correspondence.updatedAt,
};

const UNPROJECTED_DETAIL_COLUMNS = [
  "entityFeatureGate", // RLS state is internal to the gate.
  "organizationId", // Tenant scope comes from the authorized session.
  "workspaceId", // Matter scope comes from the authorized route.
  "contentHash", // Internal content fingerprint for ingestion.
  "dedupKey", // Internal replay identity.
] as const satisfies readonly (keyof CorrespondenceRow)[];

type MissingDetailColumn = UnprojectedColumns<
  CorrespondenceRow,
  typeof CORRESPONDENCE_DETAIL_COLUMNS,
  (typeof UNPROJECTED_DETAIL_COLUMNS)[number]
>;
type UnexpectedDetailColumn = UnbackedProjectionKeys<
  CorrespondenceRow,
  typeof CORRESPONDENCE_DETAIL_COLUMNS,
  (typeof UNPROJECTED_DETAIL_COLUMNS)[number]
>;
true satisfies MissingDetailColumn extends never ? true : never;
true satisfies UnexpectedDetailColumn extends never ? true : never;

const MAX_FILERS_PER_RECORD = 10_000;
const MAX_CONTACT_MATCHES_PER_BOX = 5;

type MatchDataBoxContactsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  boxId: string;
};

// Read-only: contacts whose data boxes list the box ID, served by
// contacts_data_box_ids_idx. Contact box IDs are stored lowercase, as are
// envelope box IDs.
const matchDataBoxContacts = async ({
  tx,
  organizationId,
  boxId,
}: MatchDataBoxContactsOptions): Promise<CorrespondenceDataBoxContactMatches> => {
  const page = await readCursorPage(
    tx
      .select({ contactId: contacts.id, displayName: contacts.displayName })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          sql`(${contacts.metadata} -> 'dataBoxes') @> ${JSON.stringify([{ id: boxId }])}::text::jsonb`,
        ),
      )
      .orderBy(asc(contacts.displayName), asc(contacts.id)),
    {
      limit: MAX_CONTACT_MATCHES_PER_BOX,
      cursorForItem: ({ contactId }) => contactId,
    },
  );
  return { matches: page.items, hasMore: page.nextCursor !== null };
};

type ReadDataBoxContactsOptions = Omit<MatchDataBoxContactsOptions, "boxId"> & {
  envelope: DataBoxEnvelope;
};

const readDataBoxContacts = async ({
  envelope,
  ...options
}: ReadDataBoxContactsOptions): Promise<CorrespondenceDataBoxContacts> => {
  const [sender, recipient] = await Promise.all([
    matchDataBoxContacts({ ...options, boxId: envelope.sender.boxId }),
    matchDataBoxContacts({ ...options, boxId: envelope.recipient.boxId }),
  ]);
  return { sender, recipient };
};

const config = {
  contract: "patch",
  description:
    "Read one matter correspondence record with its filers and attachments. When intake is not direct, from, to, and the message date (sentAt) are asserted by the forwarder and are not verified; authentication verdicts in authenticatedSender describe the delivery, not the extracted original. A record whose source is upload was read from the file sourceEntityId in the matter (an email file, or a data-box .zfo file); its headers are as stated in that file and are not verified. A data_box record carries its envelope in dataBox, the files of the message as attachments, and in dataBoxContacts the organization contacts whose data boxes list the sender or recipient box ID (null on email).",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "correspondence",
    consumesServices: false,
  },
  access: "read",
  params: workspaceParams({ correspondenceId: tSafeId("correspondence") }),
} satisfies WorkspaceHandlerConfig;

const getCorrespondence = createSafeHandler(
  config,
  async function* ({
    params: { correspondenceId },
    safeDb,
    session,
    workspaceId,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const [row] = await tx
          .select(CORRESPONDENCE_DETAIL_COLUMNS)
          .from(correspondence)
          .where(
            and(
              eq(correspondence.workspaceId, workspaceId),
              eq(correspondence.id, correspondenceId),
            ),
          )
          .limit(1);
        if (row === undefined) {
          return null;
        }
        const [filers, attachments] = await Promise.all([
          tx
            .select({
              userId: correspondenceFilers.filedByUserId,
              userDisplay: correspondenceFilers.filedByDisplay,
              approvedByDisplay: correspondenceAllowedSenders.approvedByDisplay,
              allowedSenderId: correspondenceFilers.filedByAllowedSenderId,
              address: correspondenceAllowedSenders.address,
              approvedBy: correspondenceAllowedSenders.approvedBy,
              filedAt: correspondenceFilers.filedAt,
            })
            .from(correspondenceFilers)
            .leftJoin(
              correspondenceAllowedSenders,
              eq(
                correspondenceFilers.filedByAllowedSenderId,
                correspondenceAllowedSenders.id,
              ),
            )
            .where(
              and(
                eq(
                  correspondenceFilers.organizationId,
                  session.activeOrganizationId,
                ),
                eq(correspondenceFilers.workspaceId, workspaceId),
                eq(correspondenceFilers.correspondenceId, correspondenceId),
              ),
            )
            .orderBy(asc(correspondenceFilers.filedAt))
            .limit(MAX_FILERS_PER_RECORD + 1),
          tx
            .select({
              entityId: correspondenceAttachments.entityId,
              filename: correspondenceAttachments.filename,
              mediaType: correspondenceAttachments.mediaType,
              byteSize: correspondenceAttachments.byteSize,
              scanVerdict: correspondenceAttachments.scanVerdict,
            })
            .from(correspondenceAttachments)
            .where(
              and(
                eq(correspondenceAttachments.workspaceId, workspaceId),
                eq(
                  correspondenceAttachments.correspondenceId,
                  correspondenceId,
                ),
              ),
            )
            .orderBy(asc(correspondenceAttachments.ordinal))
            .limit(CORRESPONDENCE_MAX_ATTACHMENTS + 1),
        ]);
        if (filers.length > MAX_FILERS_PER_RECORD) {
          return panic("Correspondence filer count exceeds the bounded read");
        }
        if (attachments.length > CORRESPONDENCE_MAX_ATTACHMENTS) {
          return panic(
            "Correspondence attachment count exceeds the accepted limit",
          );
        }
        const organizationBoxIds =
          row.channel === "data_box"
            ? await readOrganizationDataBoxIds(tx, session.activeOrganizationId)
            : [];
        const channel = readCorrespondenceChannel(row, organizationBoxIds);
        const dataBoxContacts =
          channel.channel === "data_box"
            ? await readDataBoxContacts({
                tx,
                organizationId: session.activeOrganizationId,
                envelope: channel.dataBox,
              })
            : null;
        const {
          channel: _channel,
          dataBox: _dataBox,
          source,
          sourceEntityId,
          intake,
          originalSignature,
          authenticatedSenderAddress,
          spf,
          dkim,
          dmarc,
          alignedIdentifier,
          ...record
        } = row;
        return {
          record: {
            ...record,
            ...channel,
            ...readCorrespondenceProvenance({
              source,
              sourceEntityId,
              intake,
              originalSignature,
              authenticatedSenderAddress,
              spf,
              dkim,
              dmarc,
              alignedIdentifier,
            }),
          },
          filers: filers.map((filer) => {
            if (filer.userId !== null) {
              if (filer.userDisplay === null) {
                return panic("Missing filer display snapshot");
              }
              return {
                type: "user" as const,
                userId: filer.userId,
                userName:
                  filer.userDisplay.status === "active"
                    ? filer.userDisplay.name
                    : null,
                userStatus: filer.userDisplay.status,
                filedAt: filer.filedAt,
              };
            }
            if (
              filer.allowedSenderId === null ||
              filer.address === null ||
              filer.approvedBy === null ||
              filer.approvedByDisplay === null
            ) {
              return panic("Incomplete mailbox filer provenance");
            }
            return {
              type: "shared_mailbox" as const,
              allowedSenderId: filer.allowedSenderId,
              address: filer.address,
              approvedBy: filer.approvedBy,
              approvedByName:
                filer.approvedByDisplay.status === "active"
                  ? filer.approvedByDisplay.name
                  : null,
              approvedByStatus: filer.approvedByDisplay.status,
              filedAt: filer.filedAt,
            };
          }),
          attachments,
          dataBoxContacts,
        };
      }),
    );
    if (result === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Correspondence not found" }),
      );
    }
    return Result.ok(result);
  },
);

export default getCorrespondence;
