import { useForm, useSelector } from "@tanstack/react-form";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { INVOICE_SEND_LIMITS } from "@stll/api-contract";
import { Temporal } from "@stll/time";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { Field, FieldError } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { MailIcon, SendIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { Skeleton } from "@stll/ui/skeleton";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import type { QueryView } from "@/lib/query-view.logic";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  invoiceSendsInfiniteOptions,
  invoiceSendsOptions,
  invoicesKeys,
} from "@/lib/workspaces/queries/invoices";
import type { InvoiceSends } from "@/lib/workspaces/queries/invoices";

import {
  initialRecipientsText,
  sendInvoiceFormSchema,
} from "./invoice-sends.logic";

type InvoiceSend = InvoiceSends["items"][number];
type LinkStatus = InvoiceSend["linkStatus"];

const LINK_STATUS_STYLES = {
  active: "bg-[var(--option-emerald-bg)] text-[var(--option-emerald-fg)]",
  expired: "bg-muted text-muted-foreground",
  revoked: "bg-muted text-muted-foreground",
  failed: "bg-[var(--option-red-bg)] text-[var(--option-red-fg)]",
} as const satisfies Record<LinkStatus, string>;

type InvoiceRef = { workspaceId: string; invoiceId: string };

const invoiceApi = ({ workspaceId, invoiceId }: InvoiceRef) =>
  api.invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
    invoiceId: toSafeId<"invoice">(invoiceId),
  });

type SendInvoiceFormProps = InvoiceRef & {
  invoiceNumber: string;
  /** Addresses to start from; null starts from the client's. */
  recipients: readonly string[] | null;
  onClose: () => void;
};

/** The send dialog's body: who gets the link, and an optional note. */
export const SendInvoiceForm = ({
  workspaceId,
  invoiceId,
  invoiceNumber,
  recipients,
  onClose,
}: SendInvoiceFormProps) => {
  const t = useTranslations("billing.invoices.sending");
  const rootT = useTranslations();
  const queryClient = useQueryClient();
  const userId = useAuthenticatedUser().id;
  const sends = queryView(
    useQuery(invoiceSendsOptions({ workspaceId, invoiceId, userId })),
    { isEmpty: () => false },
  );
  useQueryViewError(sends, "SendInvoiceForm:query");

  const onSent = async ({
    failedRecipients,
  }: {
    failedRecipients: string[];
  }) => {
    stellaToast.add({
      type: failedRecipients.length === 0 ? "success" : "warning",
      title:
        failedRecipients.length === 0
          ? t("sent")
          : t("sentPartial", { addresses: failedRecipients.join(", ") }),
    });
    await queryClient.invalidateQueries({
      queryKey: invoicesKeys.all(workspaceId),
    });
    onClose();
  };

  if (sends.type === "pending") {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <SendInvoiceFields
      defaultRecipients={initialRecipientsText(
        recipients,
        // Without the history the form still sends; it starts empty.
        sends.type === "items" ? sends.items.defaultRecipients : [],
      )}
      invoiceNumber={invoiceNumber}
      onClose={onClose}
      onSent={onSent}
      replyTo={sends.type === "items" ? sends.items.replyTo : null}
      send={async (values) => {
        const response = await invokeCapability(
          "invoices.sends.create",
          async (request) =>
            invoiceApi({ workspaceId, invoiceId }).sends.post(
              {
                recipients: values.recipients,
                ...(values.message === "" ? {} : { message: values.message }),
              },
              request,
            ),
        );
        if (response.error) {
          notifyUserError(toAPIError(response.error), t("failed"));
          return null;
        }
        return response.data;
      }}
      title={rootT("billing.invoices.sending.title", { number: invoiceNumber })}
    />
  );
};

type SendInvoiceFieldsProps = {
  title: string;
  invoiceNumber: string;
  defaultRecipients: string;
  replyTo: string | null;
  send: (values: {
    recipients: string[];
    message: string;
  }) => Promise<{ failedRecipients: string[] } | null>;
  onSent: (result: { failedRecipients: string[] }) => Promise<void>;
  onClose: () => void;
};

const SendInvoiceFields = ({
  title,
  defaultRecipients,
  replyTo,
  send,
  onSent,
  onClose,
}: SendInvoiceFieldsProps) => {
  const t = useTranslations("billing.invoices.sending");
  const rootT = useTranslations();
  const schema = sendInvoiceFormSchema({
    required: t("recipientsRequired"),
    tooMany: t("recipientsTooMany", { max: INVOICE_SEND_LIMITS.maxRecipients }),
    invalid: t("recipientsInvalid"),
    messageTooLong: t("messageTooLong", {
      max: INVOICE_SEND_LIMITS.messageMaxChars,
    }),
  });
  const form = useForm(
    schemaFormOptions({
      schema,
      defaultValues: { recipients: defaultRecipients, message: "" },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => {
        const sent = await send(value);
        if (sent !== null) {
          await onSent(sent);
        }
      },
    }),
  );
  const { formErrors, dirty } = useSelector(form.store, (s) => ({
    formErrors: toFormErrors(s.fieldMeta),
    dirty: !s.isDefaultValue,
  }));

  return (
    <Form
      className="m-4 flex flex-col gap-4"
      dirty={dirty}
      errors={formErrors}
      onDiscard={() => form.reset()}
      onSubmit={(event) => {
        event.preventDefault();
        detached(form.handleSubmit(), "invoice-send.submit");
      }}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-muted-foreground text-xs">{t("linkInfo")}</p>
      </div>
      <form.Field name="recipients">
        {(field) => (
          <Field name={field.name}>
            <Label>{t("recipients")}</Label>
            <Textarea
              dir="ltr"
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              rows={3}
              value={field.state.value}
            />
            <p className="text-muted-foreground text-xs">
              {t("recipientsHint", { max: INVOICE_SEND_LIMITS.maxRecipients })}
            </p>
            <FieldError />
          </Field>
        )}
      </form.Field>
      <form.Field name="message">
        {(field) => (
          <Field name={field.name}>
            <Label>{t("message")}</Label>
            <Textarea
              maxLength={INVOICE_SEND_LIMITS.messageMaxChars}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder={t("messagePlaceholder")}
              rows={3}
              value={field.state.value}
            />
            <FieldError />
          </Field>
        )}
      </form.Field>
      {replyTo === null ? null : (
        <p className="text-muted-foreground text-xs">
          {t("replyTo", { address: replyTo })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} type="button" variant="ghost">
          {rootT("common.cancel")}
        </Button>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button loading={isSubmitting} type="submit">
              <SendIcon className="size-3.5" />
              {rootT("billing.invoices.send")}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </Form>
  );
};

type InvoiceSendsSectionProps = InvoiceRef & {
  canSend: boolean;
  onSendAgain: (recipients: readonly string[]) => void;
};

/** The invoice's delivery history: each send, its link, and its controls. */
export const InvoiceSendsSection = ({
  workspaceId,
  invoiceId,
  canSend,
  onSendAgain,
}: InvoiceSendsSectionProps) => {
  const t = useTranslations("billing.invoices.sending");
  const rootT = useTranslations();
  const userId = useAuthenticatedUser().id;
  const sends = useInfiniteQuery(
    invoiceSendsInfiniteOptions({ workspaceId, invoiceId, userId }),
  );
  const view = queryView(sends);
  useQueryViewError(view, "InvoiceSendsSection:query");

  return (
    <section className="rounded-lg border">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <MailIcon className="text-muted-foreground size-4" />
        <h3 className="text-sm font-medium">{t("historyTitle")}</h3>
      </div>
      <InvoiceSendsBody
        canSend={canSend}
        invoiceId={invoiceId}
        onSendAgain={onSendAgain}
        view={view}
        workspaceId={workspaceId}
      />
      {sends.hasNextPage && (
        <div className="border-t px-4 py-2">
          <Button
            loading={sends.isFetchingNextPage}
            onClick={() => {
              detached(sends.fetchNextPage(), "invoice-sends.fetch-next-page");
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            {rootT("common.loadMore")}
          </Button>
        </div>
      )}
    </section>
  );
};

const InvoiceSendsBody = ({
  view,
  ...row
}: InvoiceSendsSectionProps & {
  view: QueryView<InvoiceSend[], Error>;
}) => {
  const t = useTranslations("billing.invoices.sending");
  switch (view.type) {
    case "pending":
      return (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      );
    case "error":
      return (
        <p className="text-muted-foreground p-4 text-sm">{t("loadFailed")}</p>
      );
    case "empty":
      return (
        <p className="text-muted-foreground p-4 text-sm">{t("historyEmpty")}</p>
      );
    case "items":
      return (
        <ul className="divide-y">
          {view.items.map((send) => (
            <InvoiceSendRow key={send.id} send={send} {...row} />
          ))}
        </ul>
      );
    default:
      view satisfies never;
      return panic("Unhandled invoice sends view");
  }
};

const InvoiceSendRow = ({
  send,
  workspaceId,
  invoiceId,
  canSend,
  onSendAgain,
}: InvoiceSendsSectionProps & { send: InvoiceSend }) => {
  const t = useTranslations("billing.invoices.sending");
  const rootT = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const when = (iso: string) =>
    format.dateTime(
      Temporal.Instant.from(iso).epochMilliseconds,
      MEDIUM_DATE_SHORT_TIME_FORMAT,
    );

  const revoke = useMutation({
    mutationFn: async () =>
      unwrapApiResponse(
        await invokeCapability("invoices.sends.revoke", async (request) =>
          invoiceApi({ workspaceId, invoiceId })
            .sends({ sendId: toSafeId<"invoiceSend">(send.id) })
            .revoke.post({}, request),
        ),
      ),
    onSuccess: async () => {
      stellaToast.add({ type: "success", title: t("revoked") });
      await queryClient.invalidateQueries({
        queryKey: invoicesKeys.all(workspaceId),
      });
    },
    onError: (error) => {
      notifyUserError(error, rootT("errors.actionFailed"));
    },
  });

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-sm font-medium" dir="ltr">
          {send.recipients.join(", ")}
        </p>
        <p className="text-muted-foreground text-xs">
          {send.sentBy === null
            ? when(send.createdAt)
            : t("sentBy", {
                date: when(send.createdAt),
                name: send.sentBy.name,
              })}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cn(
              "inline-flex items-center rounded-md px-2 py-0.5 font-medium",
              LINK_STATUS_STYLES[send.linkStatus],
            )}
          >
            {t(`linkStatus.${send.linkStatus}`)}
          </span>
          <span className="text-muted-foreground">
            {send.firstViewedAt === null
              ? t("notOpened")
              : t("opened", { date: when(send.firstViewedAt) })}
          </span>
        </div>
        {send.failedRecipients.length > 0 && send.linkStatus !== "failed" ? (
          <p className="text-xs text-[var(--option-red-fg)]" dir="ltr">
            {t("notDelivered", {
              addresses: send.failedRecipients.join(", "),
            })}
          </p>
        ) : null}
      </div>
      {canSend ? (
        <div className="flex shrink-0 items-center gap-2">
          {send.linkStatus === "active" ? (
            <AlertDialog>
              <AlertDialogTrigger
                nativeButton
                render={
                  <Button loading={revoke.isPending} size="sm" variant="ghost">
                    {t("revoke")}
                  </Button>
                }
              />
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("revokeTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("revokeConfirm")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="ghost" />}>
                    {rootT("common.cancel")}
                  </AlertDialogClose>
                  <AlertDialogClose
                    render={
                      <Button
                        onClick={() => revoke.mutate()}
                        variant="destructive"
                      />
                    }
                  >
                    {t("revoke")}
                  </AlertDialogClose>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          ) : null}
          <Button
            onClick={() => onSendAgain(send.recipients)}
            size="sm"
            variant="outline"
          >
            <SendIcon className="size-3.5" />
            {t("sendAgain")}
          </Button>
        </div>
      ) : null}
    </li>
  );
};
