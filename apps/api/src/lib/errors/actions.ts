import { isTaggedError, Panic } from "better-result";
import type { ActionContextOf } from "rivetkit";

import { env } from "@/api/env";
import type { ActorsUnion } from "@/api/handlers/registry";
import { getAnalytics } from "@/api/lib/analytics";
import { Unreachable } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";

export type CaptureActorErrorProps = {
  c: ActionContextOf<ActorsUnion>;
  requestId: string;
  error: unknown;
  metadata?: Record<string, string>;
};

export const captureActorError = ({
  c,
  requestId,
  error,
  metadata,
}: CaptureActorErrorProps) => {
  const tag = errorTag(error);

  const safeMetadata = {
    ...metadata,
    actorName: c.name,
    actorKey: c.key.join(":"),
    actorId: c.actorId,
    requestId,
    errorTag: tag,
  };

  if (env.isDev) {
    // eslint-disable-next-line no-console
    console.error(error);
  }

  // Structured log with tag only; never log .message, .cause,
  // or .stack (may contain privileged document content).
  if (isTaggedError(error)) {
    const level =
      Panic.is(error) || Panic.is(error.cause) || Unreachable.is(error)
        ? "fatal"
        : "error";
    c.log[level]({ _tag: tag, ...safeMetadata });
  } else {
    c.log.error({ _tag: tag, ...safeMetadata });
  }

  // Send only the structural tag + safe IDs to analytics.
  // capture() is synchronous (queues internally); no await needed.
  const analytics = getAnalytics();
  analytics.capture({
    distinctId: "server",
    event: "$exception",
    properties: {
      $exception_type: tag,
      ...safeMetadata,
    },
  });
};
