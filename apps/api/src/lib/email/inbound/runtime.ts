import { rlsDb } from "@/api/db/root";
import { ingestInboundMail } from "@/api/lib/email/inbound/ingest";
import { createInboundMailPersistence } from "@/api/lib/email/inbound/persistence";
import { receiveSesInboundMail as receiveSesDelivery } from "@/api/lib/email/inbound/ses";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";

type ReceiveInboundMailOptions = Omit<
  Parameters<typeof ingestInboundMail>[0],
  "persist"
>;

const createPersistence = () =>
  createInboundMailPersistence({
    database: rlsDb,
    scopedDbForMatter: (scope) =>
      createRootScopedDb({
        organizationId: scope.organizationId,
        userId: scope.userId,
        workspaceIds: [scope.workspaceId],
      }),
  });

export const receiveInboundMail = async (options: ReceiveInboundMailOptions) =>
  await ingestInboundMail({ ...options, persist: createPersistence() });

type ReceiveSesInboundMailOptions = Omit<
  Parameters<typeof receiveSesDelivery>[0],
  "persist"
>;

// The host authenticates the notification publisher and retains the S3 object
// and queue delivery until success. An error means retry; a drop means ack.
export const receiveSesInboundMail = async (
  options: ReceiveSesInboundMailOptions,
) => await receiveSesDelivery({ ...options, persist: createPersistence() });
