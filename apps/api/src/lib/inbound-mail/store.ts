import { and, eq } from "drizzle-orm";

import type { CorrespondenceDropReason } from "@stll/api-contract/correspondence";

import {
  correspondenceDropLogs,
  matterInboundAddresses,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  evaluateInboundAcceptance,
  type InboundFiler,
} from "@/api/lib/inbound-mail/acceptance";
import type {
  InboundDeliveryOutcome,
  InboundDeliveryStore,
  PersistInboundDeliveryOptions,
} from "@/api/lib/inbound-mail/ingest";
import {
  resolveInboundSender,
  type InboundTransaction,
} from "@/api/lib/inbound-mail/sender";
import { brandDerivedCorrespondenceDropId } from "@/api/lib/safe-id-boundaries";

export type FileInboundCandidateOptions<
  TTransaction extends InboundTransaction,
> = {
  tx: TTransaction;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  filer: InboundFiler;
  delivery: Extract<
    PersistInboundDeliveryOptions["delivery"],
    { status: "candidate" }
  >;
};

type CreateInboundStoreOptions<TTransaction extends InboundTransaction> = {
  database: {
    transaction: <TResult>(
      work: (tx: TTransaction) => Promise<TResult>,
    ) => Promise<TResult>;
  };
  fileCandidate: (
    options: FileInboundCandidateOptions<TTransaction>,
  ) => Promise<
    Extract<InboundDeliveryOutcome, { status: "filed" | "duplicate" }>
  >;
};

// Only the receiving worker owns this connection. A token resolves its tenant;
// no HTTP or MCP caller can supply a workspace or organization to this store.
export const createInboundMailStore =
  <TTransaction extends InboundTransaction>({
    database,
    fileCandidate,
  }: CreateInboundStoreOptions<TTransaction>): InboundDeliveryStore =>
  async ({ token, deliveryKey, receivedAt, delivery }) =>
    await database.transaction(async (tx) => {
      const hints = await tx
        .select({ workspaceId: matterInboundAddresses.workspaceId })
        .from(matterInboundAddresses)
        .where(eq(matterInboundAddresses.token, token))
        .limit(1);
      const hint = hints.at(0);
      if (!hint) {
        return { status: "dropped", reason: "unknown_recipient" };
      }
      const matters = await tx
        .select({
          id: workspaces.id,
          organizationId: workspaces.organizationId,
          status: workspaces.status,
        })
        .from(workspaces)
        .where(eq(workspaces.id, hint.workspaceId))
        .limit(1)
        .for("update");
      const matter = matters.at(0);
      if (!matter) {
        return { status: "dropped", reason: "unknown_recipient" };
      }
      const addresses = await tx
        .select({ revokedAt: matterInboundAddresses.revokedAt })
        .from(matterInboundAddresses)
        .where(
          and(
            eq(matterInboundAddresses.workspaceId, matter.id),
            eq(matterInboundAddresses.organizationId, matter.organizationId),
            eq(matterInboundAddresses.token, token),
          ),
        )
        .limit(1)
        .for("update");
      const address = addresses.at(0);
      if (!address) {
        return { status: "dropped", reason: "unknown_recipient" };
      }
      const drop = async (
        reason: CorrespondenceDropReason,
      ): Promise<InboundDeliveryOutcome> => {
        await tx
          .insert(correspondenceDropLogs)
          .values({
            id: brandDerivedCorrespondenceDropId(matter.id, deliveryKey),
            workspaceId: matter.id,
            organizationId: matter.organizationId,
            senderAddress: delivery.sender ?? "",
            reason,
            receivedAt: new Date(receivedAt),
          })
          .onConflictDoNothing({ target: correspondenceDropLogs.id });
        return { status: "dropped", reason };
      };
      if (address.revokedAt || matter.status !== "active") {
        return await drop("revoked_address");
      }
      if (delivery.status === "drop") {
        return await drop(delivery.reason);
      }
      const membership = await resolveInboundSender({
        tx,
        workspaceId: matter.id,
        organizationId: matter.organizationId,
        sender: delivery.sender,
        receivedAt,
      });
      const accepted = evaluateInboundAcceptance({
        outerSender: delivery.sender,
        authentication: delivery.authentication,
        membership,
        scan: "pass",
      });
      if (accepted.status === "drop") {
        return await drop(
          accepted.reason === "sender-not-authorized"
            ? "unauthorized_sender"
            : "authentication_failed",
        );
      }
      return await fileCandidate({
        tx,
        workspaceId: matter.id,
        organizationId: matter.organizationId,
        filer: accepted.filer,
        delivery,
      });
    });
