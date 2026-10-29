import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";
import { DAY_IN_MS, Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import {
  brandPersistedInvoiceId,
  brandPersistedInvoiceSendId,
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

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
  tokenHash: string;
  invoiceId: SafeId<"invoice">;
  workspaceIds: SafeId<"workspace">[];
};

const invoiceLinkScopeRowSchema = v.object({
  send_id: v.pipe(v.string(), v.transform(brandPersistedInvoiceSendId)),
  organization_id: v.pipe(
    v.string(),
    v.transform(brandPersistedOrganizationId),
  ),
  invoice_id: v.pipe(v.string(), v.transform(brandPersistedInvoiceId)),
  workspace_ids: v.array(
    v.pipe(v.string(), v.transform(brandPersistedWorkspaceId)),
  ),
  expires_at: v.union([
    v.date(),
    v.pipe(
      v.string(),
      v.transform(
        (value) => new Date(Temporal.Instant.from(value).epochMilliseconds),
      ),
    ),
  ]),
});

/** The same parser validates the SECURITY DEFINER result at entry and snapshot rechecks. */
const parseInvoiceLinkScopeRow = (row: unknown) =>
  v.parse(invoiceLinkScopeRowSchema, row);

export const readInvoiceLinkScope = async (
  tx: Transaction,
  tokenHash: string,
) => {
  const result = await tx.execute(
    sql`SELECT * FROM invoice_link_scope(${tokenHash})`,
  );
  const raw = executedRows(result).at(0);
  if (raw === undefined) {
    return null;
  }
  const row = parseInvoiceLinkScopeRow(raw);
  if (row.workspace_ids.length === 0) {
    return null;
  }
  return {
    sendId: row.send_id,
    organizationId: row.organization_id,
    invoiceId: row.invoice_id,
    workspaceIds: row.workspace_ids,
    expiresAt: row.expires_at,
    tokenHash,
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
  return await db.tenantless(
    async (tx) => await readInvoiceLinkScope(tx, hashInvoiceLinkToken(token)),
  );
};
