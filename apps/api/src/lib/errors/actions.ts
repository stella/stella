import { isTaggedError, Panic } from "better-result";
import type { ActionContextOf } from "rivetkit";

import { env } from "@/api/env";
import type { ActorsUnion } from "@/api/handlers/registry";
import { Unreachable } from "@/api/lib/errors/tagged-errors";
import { extractErrorMessage, serializeCause } from "@/api/lib/errors/utils";
import { getPostHog } from "@/api/lib/posthog";

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
  const posthog = getPostHog();

  const errorMetadata = {
    ...metadata,
    actorName: c.name,
    actorKey: c.key,
    actorId: c.actorId,
    requestId,
  };

  if (env.isDev) {
    // biome-ignore lint/suspicious/noConsole: debug
    console.error(error);
  }

  if (isTaggedError(error)) {
    const data = {
      _tag: error._tag,
      name: error.name,
      message: error.message,
      cause: serializeCause(error.cause),
      stack: error.stack,
    };
    if (Panic.is(error) || Panic.is(error.cause) || Unreachable.is(error)) {
      c.log.fatal(data);
    } else {
      c.log.error(data);
    }
  } else if (error instanceof Error) {
    c.log.error({
      name: error.name,
      message: error.message,
      cause: serializeCause(error.cause),
      stack: error.stack,
    });
  } else {
    c.log.error({
      name: "Unknown error",
      message: extractErrorMessage(error),
      rawError:
        typeof error === "object" ? JSON.stringify(error) : String(error),
    });
  }

  c.waitUntil(
    posthog.captureExceptionImmediate(error, undefined, errorMetadata),
  );
};
