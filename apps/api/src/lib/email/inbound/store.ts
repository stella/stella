import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { CorrespondenceDropReason } from "@stll/api-contract/correspondence";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  WORKSPACE_ACCESS_MODE,
  stella,
} from "@/api/db/rls";
import {
  correspondenceDropLogs,
  matterInboundAddresses,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  evaluateInboundAcceptance,
  type InboundFiler,
} from "@/api/lib/email/inbound/acceptance";
import {
  InboundPersistenceError,
  type InboundDeliveryOutcome,
  type InboundDeliveryStore,
  type PersistInboundDeliveryOptions,
} from "@/api/lib/email/inbound/ingest";
import {
  resolveInboundSender,
  lookupInboundPrimaryAccount,
  type InboundTransaction,
} from "@/api/lib/email/inbound/sender";
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
    Result<
      Extract<InboundDeliveryOutcome, { status: "filed" | "duplicate" }>,
      InboundPersistenceError
    >
  >;
};

// Only the receiving worker owns this connection. A token resolves its tenant;
// no HTTP or MCP caller can supply a workspace or organization to this store.
export const createInboundMailStore =
  <TTransaction extends InboundTransaction>({
    database,
    fileCandidate,
  }: CreateInboundStoreOptions<TTransaction>): InboundDeliveryStore =>
  async ({ token, deliveryKey, receivedAt, delivery }) => {
    const aborted: { error: InboundPersistenceError | null } = { error: null };
    return await Result.tryPromise({
      try: () =>
        database.transaction(async (tx): Promise<InboundDeliveryOutcome> => {
          await tx.execute(
            sql`select set_config('app.inbound_token', ${token}, true)`,
          );
          const hints = await tx
            .select({
              workspaceId: matterInboundAddresses.workspaceId,
              organizationId: matterInboundAddresses.organizationId,
            })
            .from(matterInboundAddresses)
            .where(eq(matterInboundAddresses.token, token))
            .limit(1);
          const hint = hints.at(0);
          if (!hint) {
            return { status: "dropped", reason: "unknown_recipient" };
          }
          const primaryUserId =
            delivery.status === "candidate"
              ? await lookupInboundPrimaryAccount({
                  tx,
                  organizationId: hint.organizationId,
                  sender: delivery.sender,
                })
              : null;
          const setMatterContext = async () => {
            await tx.execute(sql`select
          set_config('role', ${stella.name}, true),
          set_config(${SETTING_USER_ID}, '', true),
          set_config(${SETTING_ORGANIZATION_ID}, ${hint.organizationId}, true),
          set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true),
          set_config(${SETTING_WORKSPACE_IDS}, ${`{${hint.workspaceId}}`}, true)`);
          };
          await setMatterContext();
          const matters = await tx
            .select({
              id: workspaces.id,
              organizationId: workspaces.organizationId,
              status: workspaces.status,
            })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.id, hint.workspaceId),
                eq(workspaces.organizationId, hint.organizationId),
              ),
            )
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
                eq(
                  matterInboundAddresses.organizationId,
                  matter.organizationId,
                ),
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
            primaryUserId,
            workspaceId: matter.id,
            organizationId: matter.organizationId,
            sender: delivery.sender,
            receivedAt,
          });
          await setMatterContext();
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
          const filed = await fileCandidate({
            tx,
            workspaceId: matter.id,
            organizationId: matter.organizationId,
            filer: accepted.filer,
            delivery,
          });
          if (filed.isErr()) {
            aborted.error = filed.error;
            return tx.rollback();
          }
          return filed.value;
        }),
      catch: (cause) =>
        aborted.error ??
        new InboundPersistenceError({
          message: "Inbound transaction could not complete",
          cause,
        }),
    });
  };
