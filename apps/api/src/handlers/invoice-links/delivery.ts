import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import type { InvoiceLinkFile } from "@/api/handlers/invoice-links/file-preparation";
import {
  anchorMatter,
  invoiceLinkAuditBindings,
  linkUnavailable,
} from "@/api/handlers/invoice-links/link-access";
import type { InvoiceLinkCaller } from "@/api/handlers/invoice-links/link-access";
import type { RequestContext } from "@/api/http/context";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resolveClientIp } from "@/api/lib/client-ip";
import { recordGatedAuditEvent } from "@/api/lib/db/audit-recording";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";

type InvoiceLinkDelivery =
  | { type: "view" }
  | { type: "download"; file: InvoiceLinkFile; fileName: string };

type InvoiceLinkDeliveryOptions<TResponse> = {
  caller: InvoiceLinkCaller;
  workspaceId: InvoiceLinkCaller["workspaceIds"][number] | null;
  delivery: InvoiceLinkDelivery;
  context: Pick<RequestContext, "request" | "server">;
  response: () => TResponse;
};

/** Every successful public response is constructed only after the final live-link/audit statement commits. */
export const deliverInvoiceLink = async <
  TResponse extends NonNullable<unknown>,
>({
  caller,
  workspaceId,
  delivery,
  context,
  response,
}: InvoiceLinkDeliveryOptions<TResponse>): Promise<
  Result<TResponse, HandlerError>
> => {
  const event = (() => {
    switch (delivery.type) {
      case "view":
        return {
          action: AUDIT_ACTION.ACCESS,
          metadata: { invoiceSendId: caller.sendId, via: "invoice_link" },
        };
      case "download":
        return {
          action: AUDIT_ACTION.DOWNLOAD,
          metadata: {
            invoiceSendId: caller.sendId,
            via: "invoice_link",
            file: delivery.file,
            fileName: delivery.fileName,
          },
        };
      default:
        delivery satisfies never;
        return panic("Unhandled invoice link delivery kind");
    }
  })();
  const live = await caller.scopedDb(
    async (tx) =>
      await recordGatedAuditEvent({
        tx,
        gate: sql`public.invoice_link_mark_viewed(${caller.tokenHash})`,
        bindings: invoiceLinkAuditBindings(caller, workspaceId),
        event: {
          ...event,
          resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
          resourceId: caller.invoiceId,
          workspaceId: workspaceId ?? anchorMatter(caller),
        },
        requestMetadata: {
          ipAddress: resolveClientIp(context.request, context.server),
          userAgent: context.request.headers.get("user-agent"),
        },
      }),
  );
  return live ? Result.ok(response()) : Result.err(linkUnavailable());
};
