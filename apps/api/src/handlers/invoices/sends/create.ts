import { Result } from "better-result";
import { and, count, eq, gt, sql } from "drizzle-orm";
import * as v from "valibot";

import { INVOICE_SEND_LIMITS } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { resultTx } from "@/api/db/safe-db";
import { INVOICE_STATUS, invoices, invoiceSends } from "@/api/db/schema";
import type { InvoiceSendDeliveryStatus, InvoiceStatus } from "@/api/db/schema";
import { createInvoiceFormatters } from "@/api/handlers/invoices/pdf/render-helpers";
import { sendFinalizedInvoice } from "@/api/handlers/invoices/transition";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  createInvoiceLinkToken,
  hashInvoiceLinkToken,
  INVOICE_SENDS_PER_INVOICE_PER_DAY,
  INVOICE_SENDS_PER_ORGANIZATION_PER_DAY,
  invoiceLinkExpiresAt,
  invoiceLinkUrl,
} from "@/api/lib/billing/invoice-links";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { lockInvoiceInStatus } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  isTransactionalEmailConfigured,
  sendInvoiceLinkEmail,
} from "@/api/lib/email/email";
import { emailAddressSchema } from "@/api/lib/email/normalized-email";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { readOrganizationTimeZone } from "@/api/lib/organization-time-zone";
import { isRecord } from "@/api/lib/type-guards";
import { isLocalDevOpen } from "@/api/runtime-mode";

/** Issued documents only: a draft has no number, a void one is not owed. */
const SENDABLE_STATUSES = [
  INVOICE_STATUS.FINALIZED,
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.PAID,
] as const satisfies readonly InvoiceStatus[];

const isSendable = (status: InvoiceStatus) =>
  SENDABLE_STATUSES.some((sendable) => sendable === status);

const recipientSchema = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(254),
  emailAddressSchema,
);

const sendInvoiceBody = v.strictObject({
  recipients: v.pipe(
    v.array(recipientSchema),
    v.minLength(INVOICE_SEND_LIMITS.minRecipients),
    v.maxLength(INVOICE_SEND_LIMITS.maxRecipients),
    v.transform((addresses) => [...new Set(addresses)]),
    v.description(
      "Addresses to email the link to, at most 10. Nothing goes to an address not named here.",
    ),
  ),
  message: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(INVOICE_SEND_LIMITS.messageMaxChars),
      v.description("A short note shown in the email."),
    ),
  ),
});

export type InvoiceLinkMessage = Parameters<typeof sendInvoiceLinkEmail>[0];

/** Delivers one email; rejects when the provider refuses it. */
type InvoiceLinkDelivery = (message: InvoiceLinkMessage) => Promise<void>;

type SendInvoiceDependencies = {
  deliver: InvoiceLinkDelivery;
  isDeliveryConfigured: () => boolean;
};

/**
 * The configured transport. A local development server without one prints
 * the link instead, the way it prints invitation links.
 */
const deliverInvoiceLink: InvoiceLinkDelivery = async (message) => {
  if (!isTransactionalEmailConfigured() && isLocalDevOpen()) {
    // oxlint-disable-next-line no-console -- dev-only invoice-link echo for local testing
    console.log(`[DEV] Invoice link for ${message.to}: ${message.link}`);
    return;
  }
  await sendInvoiceLinkEmail(message);
};

const isInvoiceDeliveryConfigured = () =>
  isTransactionalEmailConfigured() || isLocalDevOpen();

// A refused recipient is recorded on the send and shown to the firm.
const invoiceEmailNotDelivered = failureSink({
  event: "invoice_send.email_not_delivered",
  expected: [],
});

const sendLimitError = (scope: "invoice" | "organization") =>
  new HandlerError({
    status: 429,
    code: "invoice_send_limit",
    message:
      scope === "invoice"
        ? `This invoice was already sent ${INVOICE_SENDS_PER_INVOICE_PER_DAY} times in the last 24 hours`
        : `Your organization sent ${INVOICE_SENDS_PER_ORGANIZATION_PER_DAY} invoice emails in the last 24 hours`,
    hint: "Try again later, or download the PDF and send it yourself.",
  });

const organizationSendCount = (rows: unknown[]) => {
  const row = rows.at(0);
  return isRecord(row) && typeof row["sends"] === "number" ? row["sends"] : 0;
};

/** The send limits, read under the invoice lock so concurrent sends queue. */
const sendLimitReached = async (
  tx: Transaction,
  invoiceId: SafeId<"invoice">,
) => {
  // The rolling day by the database clock, which stamped the earlier sends.
  const since = sql`now() - interval '1 day'`;
  const [perInvoice] = await tx
    .select({ sends: count() })
    .from(invoiceSends)
    .where(
      and(
        eq(invoiceSends.invoiceId, invoiceId),
        gt(invoiceSends.createdAt, since),
      ),
    );
  if ((perInvoice?.sends ?? 0) >= INVOICE_SENDS_PER_INVOICE_PER_DAY) {
    return sendLimitError("invoice");
  }
  // Counts the whole organization, matters this member cannot read included.
  const perOrganization = organizationSendCount(
    executedRows(
      await tx.execute(
        sql`SELECT invoice_sends_organization_count(${since}) AS sends`,
      ),
    ),
  );
  if (perOrganization >= INVOICE_SENDS_PER_ORGANIZATION_PER_DAY) {
    return sendLimitError("organization");
  }
  return null;
};

type LockedInvoice = NonNullable<
  Awaited<ReturnType<typeof lockInvoiceInStatus>>
>;

type PreparedSend = {
  sendId: SafeId<"invoiceSend">;
  expiresAt: Date;
  replyTo: string;
  firmName: string;
  timeZone: string;
  invoice: LockedInvoice & { invoiceNumber: string };
};

type PrepareSendOptions = {
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  userEmail: string;
  recipients: string[];
  message: string | null;
  tokenHash: string;
  now: Date;
  recordAuditEvent: AuditRecorder;
};

const refuseUnsendable = async (
  tx: Transaction,
  { invoiceId, workspaceId }: PrepareSendOptions,
) => {
  const current = await tx.query.invoices.findFirst({
    where: {
      id: { eq: invoiceId },
      RAW: (table) => invoiceInMatter(table, workspaceId),
    },
    columns: { status: true },
  });
  if (!current) {
    return new HandlerError({ status: 404, message: "Invoice not found" });
  }
  return isSendable(current.status)
    ? null
    : new HandlerError({
        status: 409,
        code: "invoice_not_sendable",
        message: `A ${current.status} invoice cannot be sent`,
        hint: "Finalize the draft first; a void invoice is never sent.",
      });
};

/** Who the email names and who receives the replies. */
const readSender = async (
  tx: Transaction,
  options: PrepareSendOptions,
  sellerProfileId: SafeId<"sellerProfile"> | null,
) => {
  const seller =
    sellerProfileId === null
      ? undefined
      : await tx.query.sellerProfiles.findFirst({
          where: {
            id: { eq: sellerProfileId },
            organizationId: { eq: options.organizationId },
          },
          columns: { legalName: true, email: true },
        });
  const [firm] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, options.organizationId));
  return {
    firmName: seller?.legalName ?? firm?.name ?? "",
    // The seller profile's address when it has one, else the sender's own:
    // a reply always reaches the firm, never the platform.
    replyTo: seller?.email ?? options.userEmail,
  };
};

/**
 * Records the send before any email leaves: refuses a draft or void invoice
 * and a send past the limits, locks the invoice, and inserts the send with
 * its link's hash. Returns what the emails print.
 */
const prepareSend = async (
  tx: Transaction,
  options: PrepareSendOptions,
): Promise<Result<PreparedSend, HandlerError>> => {
  const unsendable = await refuseUnsendable(tx, options);
  if (unsendable !== null) {
    return Result.err(unsendable);
  }
  const locked = await lockInvoiceInStatus(tx, {
    invoiceId: options.invoiceId,
    workspaceId: options.workspaceId,
    status: [...SENDABLE_STATUSES],
    matterLocks: { type: "acquire" },
  });
  if (!locked || locked.invoiceNumber === null) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "The invoice changed while it was being sent",
        hint: "Reload the invoice and send it again.",
      }),
    );
  }
  const limit = await sendLimitReached(tx, options.invoiceId);
  if (limit !== null) {
    return Result.err(limit);
  }
  const { firmName, replyTo } = await readSender(
    tx,
    options,
    locked.sellerProfileId,
  );
  const expiresAt = invoiceLinkExpiresAt(options.now);
  const sendId = createSafeId<"invoiceSend">();
  await tx.insert(invoiceSends).values({
    id: sendId,
    organizationId: options.organizationId,
    invoiceId: options.invoiceId,
    sentByUserId: options.userId,
    recipients: options.recipients,
    message: options.message,
    language: locked.language,
    replyTo,
    tokenHash: options.tokenHash,
    expiresAt,
  });
  await options.recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
    resourceId: options.invoiceId,
    changes: { sentTo: { old: null, new: options.recipients } },
    metadata: {
      invoiceSendId: sendId,
      replyTo,
      expiresAt: expiresAt.toISOString(),
    },
  });
  return Result.ok({
    sendId,
    expiresAt,
    replyTo,
    firmName: firmName === "" ? locked.invoiceNumber : firmName,
    timeZone: await readOrganizationTimeZone(tx, options.organizationId),
    invoice: { ...locked, invoiceNumber: locked.invoiceNumber },
  });
};

/** The email every recipient gets, in the invoice's language. */
const emailFor = (
  prepared: PreparedSend,
  link: string,
  message: string | null,
): Omit<InvoiceLinkMessage, "to"> => {
  const { invoice } = prepared;
  const { money, date } = createInvoiceFormatters({
    currency: invoice.currency,
    locale: invoice.language,
  });
  const owed =
    invoice.status !== INVOICE_STATUS.PAID &&
    invoice.documentType !== "credit_note" &&
    invoice.totalAmount > 0;
  return {
    replyTo: prepared.replyTo,
    lang: invoice.language,
    documentType: invoice.documentType,
    invoiceNumber: invoice.invoiceNumber,
    firmName: prepared.firmName,
    amountDue: owed ? money(invoice.totalAmount) : null,
    dueDate: owed && invoice.dueDate !== null ? date(invoice.dueDate) : null,
    // The last day the link opens, in the firm's own time zone.
    expiresOn: date(
      Temporal.Instant.fromEpochMilliseconds(prepared.expiresAt.getTime())
        .toZonedDateTimeISO(prepared.timeZone)
        .toPlainDate()
        .toString(),
    ),
    message,
    link,
  };
};

/** One email per recipient, so no recipient sees another's address. */
const deliverAll = async (
  deliver: InvoiceLinkDelivery,
  email: Omit<InvoiceLinkMessage, "to">,
  recipients: readonly string[],
) => {
  const outcomes = await Promise.all(
    recipients.map(async (to) => {
      const sent = await Result.tryPromise(
        async () => await deliver({ ...email, to }),
      );
      if (sent.isErr()) {
        observeFailure(sent.error, { sink: invoiceEmailNotDelivered });
      }
      return { to, delivered: sent.isOk() };
    }),
  );
  return outcomes.filter((outcome) => !outcome.delivered).map(({ to }) => to);
};

const deliveryStatusOf = (
  failed: readonly string[],
  recipients: readonly string[],
): InvoiceSendDeliveryStatus => {
  if (failed.length === 0) {
    return "delivered";
  }
  return failed.length === recipients.length ? "failed" : "partial";
};

type RecordDeliveryOptions = {
  actorUserId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  prepared: PreparedSend;
  failed: string[];
  deliveryStatus: InvoiceSendDeliveryStatus;
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  now: Date;
  recordAuditEvent: AuditRecorder;
};

/**
 * Stores how the emails left. A send that reached nobody revokes its link;
 * one that reached anyone moves a finalized invoice to sent.
 */
const recordDelivery = async (
  tx: Transaction,
  options: RecordDeliveryOptions,
): Promise<Result<{ status: InvoiceStatus }, HandlerError>> => {
  const delivery = {
    deliveryStatus: options.deliveryStatus,
    failedRecipients: options.failed,
  };
  await options.recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
    resourceId: options.invoiceId,
    changes: {
      emailDelivery: { old: "pending", new: options.deliveryStatus },
    },
    metadata: {
      invoiceSendId: options.prepared.sendId,
      failedRecipients: options.failed,
    },
  });
  if (options.deliveryStatus === "failed") {
    await tx
      .update(invoiceSends)
      .set({ ...delivery, revokedAt: options.now })
      .where(eq(invoiceSends.id, options.prepared.sendId));
    return Result.ok({ status: options.prepared.invoice.status });
  }
  // A finalized invoice becomes sent through the send transition, which locks
  // the invoice row before anything else is written.
  const [current] = await tx
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, options.invoiceId));
  const sent =
    current?.status === INVOICE_STATUS.FINALIZED
      ? await sendFinalizedInvoice(tx, {
          actorUserId: options.actorUserId,
          invoiceId: options.invoiceId,
          now: options.now,
          organizationId: options.organizationId,
          recordAuditEvent: options.recordAuditEvent,
          workspaceId: options.workspaceId,
        })
      : null;
  await tx
    .update(invoiceSends)
    .set(delivery)
    .where(eq(invoiceSends.id, options.prepared.sendId));
  if (sent?.isErr() === true) {
    return Result.err(sent.error);
  }
  // Sending may settle the invoice; report the status stored by the owner.
  const [after] = await tx
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, options.invoiceId));
  return Result.ok({
    status: after?.status ?? options.prepared.invoice.status,
  });
};

const config = {
  contract: "patch",
  description:
    "Email an issued invoice to the given addresses as a secure stella link to view and download it; replies go to the seller profile's email. A finalized invoice becomes sent. Refused for drafts and void invoices. Each send makes a new link; see invoices.sends.list.",
  permissions: { invoice: ["update"] },
  // It emails people outside stella, so demo and review accounts cannot.
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  realtime: invoiceRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "billing_admin",
    consumesServices: false,
    confirmation: "required",
  },
  params: workspaceParams({ invoiceId: resourceIdSchema("invoice") }),
  body: sendInvoiceBody,
} satisfies WorkspaceHandlerConfig;

export const createSendInvoice = ({
  deliver = deliverInvoiceLink,
  isDeliveryConfigured = isInvoiceDeliveryConfigured,
}: Partial<SendInvoiceDependencies> = {}) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      user,
      session,
      workspaceId,
      params,
      body,
      recordAuditEvent,
    }) {
      if (!isDeliveryConfigured()) {
        return Result.err(
          new HandlerError({
            status: 503,
            code: "email_unavailable",
            message: "Email delivery is not configured on this server",
            hint: "Download the PDF and send it yourself, or ask the administrator to configure outgoing email.",
          }),
        );
      }
      const now = new Date();
      const token = createInvoiceLinkToken();
      const message =
        body.message === undefined || body.message === "" ? null : body.message;
      const prepared = yield* Result.await(
        resultTx(
          safeDb,
          async (tx) =>
            await prepareSend(tx, {
              invoiceId: params.invoiceId,
              workspaceId,
              organizationId: session.activeOrganizationId,
              userId: user.id,
              userEmail: user.email,
              recipients: body.recipients,
              message,
              tokenHash: hashInvoiceLinkToken(token),
              now,
              recordAuditEvent,
            }),
        ),
      );
      const failed = await deliverAll(
        deliver,
        emailFor(prepared, invoiceLinkUrl(token), message),
        body.recipients,
      );
      const deliveryStatus = deliveryStatusOf(failed, body.recipients);
      const recorded = yield* Result.await(
        resultTx(
          safeDb,
          async (tx) =>
            await recordDelivery(tx, {
              actorUserId: user.id,
              organizationId: session.activeOrganizationId,
              prepared,
              failed,
              deliveryStatus,
              invoiceId: params.invoiceId,
              workspaceId,
              now: new Date(),
              recordAuditEvent,
            }),
        ),
      );
      if (deliveryStatus === "failed") {
        return Result.err(
          new HandlerError({
            status: 502,
            code: "invoice_email_failed",
            message: "The email could not be delivered to any recipient",
            hint: "Check the addresses and send again; the link was not activated.",
            retryable: true,
          }),
        );
      }
      return Result.ok({
        id: prepared.sendId,
        deliveryStatus,
        failedRecipients: failed,
        replyTo: prepared.replyTo,
        expiresAt: prepared.expiresAt.toISOString(),
        invoiceStatus: recorded.status,
      });
    },
  );

const sendInvoice = createSendInvoice();
declareAggregateMutation(sendInvoice, {
  type: "aggregate",
  aggregates: ["workspace"],
});

export default sendInvoice;
