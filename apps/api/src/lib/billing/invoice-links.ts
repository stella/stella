import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { sha256Hex } from "@stll/sha256/bun";
import { DAY_IN_MS } from "@stll/time";

import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import {
  brandPersistedInvoiceId,
  brandPersistedInvoiceSendId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

/**
 * Invoice links: the bearer credential an invoice email carries.
 *
 * A token is 32 random bytes as 64 lowercase hex characters (256 bits). Only
 * its SHA-256 is stored, so a database read never yields a working link, and
 * a lookup compares hashes through a unique index rather than the secret
 * itself. The token travels in the URL fragment, which browsers never send
 * to a server, so neither the web host nor a mail scanner that fetches the
 * page sees it; the page posts it to the API in a request body.
 */

/** How long a link stays valid after the email leaves. */
const INVOICE_LINK_TTL_DAYS = 60;

/** Sends one invoice may take in a rolling day. */
export const INVOICE_SENDS_PER_INVOICE_PER_DAY = 5;
/** Sends one organization may make in a rolling day. */
export const INVOICE_SENDS_PER_ORGANIZATION_PER_DAY = 200;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export const createInvoiceLinkToken = (): string =>
  randomBytes(TOKEN_BYTES).toHex();

export const hashInvoiceLinkToken = (token: string): string => sha256Hex(token);

/** Exact length first, then shape, both before any hashing or lookup. */
export const isInvoiceLinkTokenShape = (value: string): boolean =>
  value.length === TOKEN_BYTES * 2 && TOKEN_PATTERN.test(value);

/** The page a recipient opens; the token rides in the fragment. */
export const invoiceLinkUrl = (token: string): string =>
  `${env.FRONTEND_URL}/invoice-link#${token}`;

export const invoiceLinkExpiresAt = (from: Date): Date =>
  new Date(from.getTime() + INVOICE_LINK_TTL_DAYS * DAY_IN_MS);

/** What a live link proves: the send, its tenant and the invoice's matters. */
export type InvoiceLinkScope = {
  sendId: SafeId<"invoiceSend">;
  organizationId: SafeId<"organization">;
  /** The sending member, retained only as nullable history. */
  userId: SafeId<"user"> | null;
  tokenHash: string;
  invoiceId: SafeId<"invoice">;
  workspaceIds: SafeId<"workspace">[];
};

const scopeOf = (row: unknown, tokenHash: string): InvoiceLinkScope | null => {
  if (
    !isRecord(row) ||
    typeof row["send_id"] !== "string" ||
    typeof row["organization_id"] !== "string" ||
    (row["user_id"] !== null && typeof row["user_id"] !== "string") ||
    typeof row["invoice_id"] !== "string" ||
    !isUnknownArray(row["workspace_ids"])
  ) {
    return null;
  }
  const workspaceIds = row["workspace_ids"].filter(
    (id): id is string => typeof id === "string",
  );
  // An invoice that bills no matter has nothing a link could show.
  if (workspaceIds.length === 0) {
    return null;
  }
  return {
    sendId: brandPersistedInvoiceSendId(row["send_id"]),
    organizationId: brandPersistedOrganizationId(row["organization_id"]),
    userId:
      row["user_id"] === null ? null : brandPersistedUserId(row["user_id"]),
    tokenHash,
    invoiceId: brandPersistedInvoiceId(row["invoice_id"]),
    workspaceIds: workspaceIds.map(brandPersistedWorkspaceId),
  };
};

/**
 * The scope of a live link, or null for a malformed, unknown, revoked or
 * expired one (and for one on a void invoice): the lookup answers only for
 * the exact hash of a live link, so every refusal looks the same.
 */
export const resolveInvoiceLink = async (
  db: TokenScopedDatabase,
  token: unknown,
): Promise<InvoiceLinkScope | null> => {
  if (typeof token !== "string" || !isInvoiceLinkTokenShape(token)) {
    return null;
  }
  const result = await db.tenantless(
    async (tx) =>
      await tx.execute(
        sql`SELECT * FROM invoice_link_scope(${hashInvoiceLinkToken(token)})`,
      ),
  );
  return scopeOf(executedRows(result).at(0), hashInvoiceLinkToken(token));
};
