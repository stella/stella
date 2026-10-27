import { panic, Result } from "better-result";

import { env } from "@/api/env";
import { resolveInboundMailReceiving } from "@/api/lib/email/inbound/receiving-config";
import { receiveSesInboundMail } from "@/api/lib/email/inbound/runtime";
import {
  createSesS3ObjectDeleter,
  createSesS3ObjectReader,
} from "@/api/lib/email/inbound/ses";
import { drainInboundMailQueue } from "@/api/lib/email/inbound/sqs";
import { sqsClientFor } from "@/api/lib/email/sns-queue-drain";
import { getFreshAbortableS3 } from "@/api/lib/s3";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";

export const RECEIVE_INBOUND_MAIL_TASK = "inboundMail.receive" as const;

export const receiveInboundMail: SchedulerTask = async ({
  dueAt,
  logger,
  scheduleContinuation,
  signal,
}) => {
  const receiving = resolveInboundMailReceiving(env);
  if (receiving.isErr()) {
    // Boot validates the same resolver, so a running API cannot reach this.
    return panic(receiving.error.message);
  }
  const config = receiving.value;
  switch (config.type) {
    case "disabled":
      logger.warn("inbound_mail.queue.disabled");
      return Result.ok(undefined);
    case "enabled":
      break;
    default:
      config satisfies never;
      return panic("Unhandled inbound mail receiving configuration");
  }
  const objectClient = await getFreshAbortableS3();
  const readObject = createSesS3ObjectReader({
    client: objectClient,
    bucket: config.bucket,
  });
  const deleteObject = createSesS3ObjectDeleter({
    client: objectClient,
    bucket: config.bucket,
  });
  const drained = await drainInboundMailQueue({
    client: sqsClientFor(config.queue),
    queueUrl: config.queue.url,
    topicArn: config.topicArn,
    signal,
    logger,
    receive: async (event) =>
      await receiveSesInboundMail({
        event,
        bucket: config.bucket,
        keyPrefix: config.keyPrefix,
        readObject,
        deleteObject,
        inboundDomain: config.inboundDomain,
      }),
  });
  if (drained.isErr()) {
    return Result.err(
      new SchedulerTaskFailure({
        message: drained.error.message,
        cause: drained.error,
      }),
    );
  }
  if (drained.value.stoppedBecause === "limitReached" && !signal.aborted) {
    scheduleContinuation(dueAt.claimedAtDate());
  }
  return Result.ok(undefined);
};
