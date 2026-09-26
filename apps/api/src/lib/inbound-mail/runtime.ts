import { rlsDb } from "@/api/db/root";
import { ingestInboundMail } from "@/api/lib/inbound-mail/ingest";
import { createInboundMailPersistence } from "@/api/lib/inbound-mail/persistence";
import { readSesInboundDelivery } from "@/api/lib/inbound-mail/ses";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";

type ReceiveInboundMailOptions = Omit<
  Parameters<typeof ingestInboundMail>[0],
  "persist"
>;

export const receiveInboundMail = async (options: ReceiveInboundMailOptions) =>
  await ingestInboundMail({
    ...options,
    persist: createInboundMailPersistence({
      database: rlsDb,
      scopedDbForMatter: (scope) =>
        createRootScopedDb({
          organizationId: scope.organizationId,
          userId: scope.userId,
          workspaceIds: [scope.workspaceId],
        }),
    }),
  });

type ReceiveSesInboundMailOptions = Parameters<
  typeof readSesInboundDelivery
>[0] & {
  inboundDomain: string;
};

// The host authenticates the notification publisher and retains the S3 object
// and queue delivery until success. An error means retry; a drop means ack.
export const receiveSesInboundMail = async ({
  inboundDomain,
  ...source
}: ReceiveSesInboundMailOptions) => {
  const delivery = await readSesInboundDelivery(source);
  if (delivery.isErr()) {
    return delivery;
  }
  const { raw, envelope, receivedAt, verify, scan } = delivery.value;
  return await receiveInboundMail({
    raw,
    envelope,
    receivedAt,
    verify,
    scan,
    inboundDomain,
  });
};
