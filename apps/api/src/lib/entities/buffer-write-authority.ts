import type { Transaction } from "@/api/db/root";

/**
 * The caller authorized the writer before producing the bytes: a request
 * handler, a tool run under its execution context, or a service path that
 * publishes on no member's behalf.
 */
export const CALLER_AUTHORIZED = { type: "caller-authorized" } as const;

/**
 * Who answers for a buffer write's authority to publish into the matter.
 * Every buffer writer names one, so a delayed member action cannot publish on
 * the authority it held when it was queued.
 */
export type BufferWriteAuthority =
  | typeof CALLER_AUTHORIZED
  | {
      /**
       * A delayed member action. Runs first in the publishing transaction,
       * before any matter or document lock, and locks and rechecks the
       * member's current authority in the member → assignment → matter order
       * that access changes take.
       */
      type: "current-member";
      authorize: (tx: Transaction) => Promise<void>;
    };

/** Recheck a delayed member's authority; the first statement of the write. */
export const authorizeBufferWrite = async (
  authority: BufferWriteAuthority,
  tx: Transaction,
): Promise<void> => {
  if (authority.type === "current-member") {
    await authority.authorize(tx);
  }
};
