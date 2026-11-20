import type { SignInCodeFailureReason } from "@stll/api-contract/email-delivery";

import { EMAIL_OTP_LIFETIME_SECONDS } from "@/api/lib/auth/email-otp-reset-confirmation";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import {
  createLazyRedisClient,
  createRedisClient,
} from "@/api/lib/redis-client";
import {
  type CoordinationKey,
  coordinationKey,
  coordinationSetArguments,
} from "@/api/lib/redis-keys";

/**
 * Which sign-in attempt sent a code mail, and whether that mail bounced, for
 * as long as the code can be used plus a short margin. Nothing here is keyed
 * by address: an attempt learns only about the one message it sent.
 */
export const SIGN_IN_CODE_DELIVERY_TTL_SECONDS =
  EMAIL_OTP_LIFETIME_SECONDS + 60;

const COMMAND_TIMEOUT_MS = 500;

// The message key's attempt and its remaining lifetime, read together so the
// failure expires when the send record does.
const READ_SENDER = `
local attempt = redis.call("GET", KEYS[1])
if not attempt then
  return false
end
return { attempt, redis.call("PTTL", KEYS[1]) }
`;

export type SignInCodeDeliveryStore = {
  /** Records that one attempt (by its hashed id) sent this message. */
  rememberSend: (send: {
    attemptKey: string;
    providerMessageId: string;
  }) => Promise<void>;
  /** Marks the attempt that sent this message failed, if one did. */
  markFailed: (failure: {
    providerMessageId: string;
    reason: SignInCodeFailureReason;
  }) => Promise<void>;
  /** The failure recorded for an attempt, if its message bounced. */
  readFailure: (attemptKey: string) => Promise<string | undefined>;
};

type RedisSender = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

const messageKey = (providerMessageId: string): CoordinationKey =>
  coordinationKey({
    scope: "sign-in-code-delivery",
    slot: providerMessageId,
    suffix: "attempt",
  });

const failureKey = (attemptKey: string): CoordinationKey =>
  coordinationKey({
    scope: "sign-in-code-delivery",
    slot: attemptKey,
    suffix: "failure",
  });

const isSenderReply = (reply: unknown): reply is [string, number] =>
  Array.isArray(reply) &&
  reply.length === 2 &&
  typeof reply[0] === "string" &&
  typeof reply[1] === "number";

type CreateSignInCodeDeliveryStoreOptions = {
  ready?: () => Promise<RedisSender>;
  commandTimeoutMs?: number;
};

export const createSignInCodeDeliveryStore = ({
  ready,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
}: CreateSignInCodeDeliveryStoreOptions = {}): SignInCodeDeliveryStore => {
  const connection: () => Promise<RedisSender> =
    ready ??
    (() => {
      const lazy = createLazyRedisClient(() =>
        createRedisClient({
          storeClass: "cache",
          overrides: {
            connectionTimeout: commandTimeoutMs,
            enableOfflineQueue: false,
          },
        }),
      );
      return async () => await lazy.ready();
    })();

  const send = async (command: string, args: string[]) =>
    await withCommandTimeout({
      command: connection().then(
        async (client) => await client.send(command, args),
      ),
      commandTimeoutMs,
      label: "sign-in-code-delivery-store",
    });

  return {
    rememberSend: async ({ attemptKey, providerMessageId }) => {
      await send(
        "SET",
        coordinationSetArguments({
          key: messageKey(providerMessageId),
          value: attemptKey,
          ttl: { unit: "seconds", value: SIGN_IN_CODE_DELIVERY_TTL_SECONDS },
        }),
      );
    },
    markFailed: async ({ providerMessageId, reason }) => {
      const sender = await send("EVAL", [
        READ_SENDER,
        "1",
        messageKey(providerMessageId),
      ]);
      if (!isSenderReply(sender)) {
        return;
      }
      const [attemptKey, remainingMs] = sender;
      if (remainingMs <= 0) {
        return;
      }
      await send(
        "SET",
        coordinationSetArguments({
          key: failureKey(attemptKey),
          value: reason,
          ttl: { unit: "milliseconds", value: remainingMs },
        }),
      );
    },
    readFailure: async (attemptKey) => {
      const reply = await send("GET", [failureKey(attemptKey)]);
      return typeof reply === "string" ? reply : undefined;
    },
  };
};

let defaultStore: SignInCodeDeliveryStore | undefined;

/** The process's store, created on first use. */
export const getSignInCodeDeliveryStore = (): SignInCodeDeliveryStore => {
  defaultStore ??= createSignInCodeDeliveryStore();
  return defaultStore;
};
