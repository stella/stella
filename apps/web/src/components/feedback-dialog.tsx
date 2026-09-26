import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { panic, Result } from "better-result";
import { CopyIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  FEEDBACK_AREAS,
  FEEDBACK_KINDS,
  FEEDBACK_LIMITS,
} from "@stll/api-contract/feedback";
import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { COMMUNITY_CHANNELS } from "@/components/feedback-community-items";
import {
  buildFeedbackRequestBody,
  FEEDBACK_AREA_LABEL_KEYS,
  FEEDBACK_CHANNELS,
  FEEDBACK_DEFAULT_KIND,
  FEEDBACK_KIND_LABEL_KEYS,
  feedbackReceiptSchema,
  resolveFeedbackArea,
} from "@/components/feedback-dialog.logic";
import type {
  FeedbackChannel,
  FeedbackReceiptView,
} from "@/components/feedback-dialog.logic";
import type { ErrorReference } from "@/lib/analytics/error-reference";
import { useAnalytics } from "@/lib/analytics/provider";
import type { FeedbackReportSource } from "@/lib/analytics/types";
import { api, publicFeedbackApi } from "@/lib/api";
import { detached } from "@/lib/detached";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { sanitizeHref } from "@/lib/sanitize-href";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

const RATE_LIMITED_STATUS = 429;

type FeedbackRequestBody = ReturnType<typeof buildFeedbackRequestBody>;

const submitFeedbackReport = async (
  channel: FeedbackChannel,
  body: FeedbackRequestBody,
): Promise<FeedbackReceiptView> => {
  switch (channel) {
    case FEEDBACK_CHANNELS.account:
      return unwrapEden(await api.feedback.post(body));
    case FEEDBACK_CHANNELS.public: {
      // The intake parses the raw text itself so it can reject unknown keys.
      const data = unwrapEden(
        await publicFeedbackApi.post(JSON.stringify(body)),
      );
      const receipt = v.safeParse(feedbackReceiptSchema, data);
      if (!receipt.success) {
        throw new ClientOperationError({
          action: "feedback.submit_public",
          message: "Feedback intake answered without a receipt",
          cause: receipt.issues,
        });
      }
      return receipt.output;
    }
    default:
      channel satisfies never;
      return panic(`Unhandled feedback channel: ${String(channel)}`);
  }
};

type FeedbackDialogProps = {
  channel: FeedbackChannel;
  /** Set when the dialog is opened from the route error screen; travels with
   *  the report so support can join it to the captured exception. */
  errorReference?: ErrorReference | undefined;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  source: FeedbackReportSource;
};

/**
 * Collects a structured report and posts it through `channel`. The popup
 * unmounts on close, so each opening starts from a clean form and a clean
 * mutation; nothing typed here survives a dismissal.
 *
 * The opener records `feedback_dialog_opened`: a controlled dialog never
 * reports an open its parent caused, so the capture belongs with the trigger.
 */
export const FeedbackDialog = ({
  channel,
  errorReference,
  onOpenChange,
  open,
  source,
}: FeedbackDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogPopup className="max-w-xl">
      <FeedbackReport
        channel={channel}
        errorReference={errorReference}
        onClose={() => onOpenChange(false)}
        source={source}
      />
    </DialogPopup>
  </Dialog>
);

type FeedbackReportProps = {
  channel: FeedbackChannel;
  errorReference: ErrorReference | undefined;
  onClose: () => void;
  source: FeedbackReportSource;
};

const FeedbackReport = ({
  channel,
  errorReference,
  onClose,
  source,
}: FeedbackReportProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const route = useLocation({ select: (location) => location.pathname });

  const schema = v.strictObject({
    kind: v.picklist(FEEDBACK_KINDS),
    area: v.picklist(FEEDBACK_AREAS),
    title: v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(t("common.required")),
      v.maxLength(FEEDBACK_LIMITS.title),
    ),
    whatHappened: v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(t("common.required")),
      v.maxLength(FEEDBACK_LIMITS.whatHappened),
    ),
    steps: v.pipe(v.string(), v.trim(), v.maxLength(FEEDBACK_LIMITS.steps)),
  });

  const submit = useMutation({
    mutationFn: async (report: v.InferOutput<typeof schema>) =>
      await submitFeedbackReport(
        channel,
        buildFeedbackRequestBody({
          clientVersion: __APP_VERSION__,
          errorReference,
          report,
          route,
        }),
      ),
    onSuccess: (_response, report) => {
      analytics.captureFeedbackReportSubmitted({
        area: report.area,
        kind: report.kind,
        source,
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      const rateLimited =
        APIError.is(error) && error.status === RATE_LIMITED_STATUS;
      stellaToast.add({
        title: rateLimited
          ? t("feedback.rateLimited")
          : userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });

  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "schema-output",
      defaultValues: {
        kind: FEEDBACK_DEFAULT_KIND,
        area: resolveFeedbackArea(route),
        title:
          errorReference === undefined
            ? ""
            : t("feedback.errorTitle", { reference: errorReference }),
        whatHappened: "",
        steps: "",
      },
      onSubmit: ({ value }) => {
        submit.mutate(value);
      },
    }),
  );
  const formErrors = useSelector(form.store, (state) =>
    toFormErrors(state.fieldMeta),
  );

  if (submit.status === "success") {
    return <FeedbackReceipt onClose={onClose} response={submit.data} />;
  }

  return (
    <Form
      className="gap-0"
      errors={formErrors}
      onSubmit={(event) => {
        event.preventDefault();
        detached(form.handleSubmit(), "feedback-dialog.submit");
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("feedback.title")}</DialogTitle>
        <DialogDescription>{t("feedback.description")}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <form.Field name="kind">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel>{t("common.kind")}</FieldLabel>
                <Select
                  onValueChange={(value) => {
                    if (value !== null) {
                      field.handleChange(value);
                    }
                  }}
                  value={field.state.value}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {FEEDBACK_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {t(FEEDBACK_KIND_LABEL_KEYS[kind])}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldError />
              </Field>
            )}
          </form.Field>

          <form.Field name="area">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel>{t("feedback.area")}</FieldLabel>
                <Select
                  onValueChange={(value) => {
                    if (value !== null) {
                      field.handleChange(value);
                    }
                  }}
                  value={field.state.value}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {FEEDBACK_AREAS.map((area) => (
                      <SelectItem key={area} value={area}>
                        {t(FEEDBACK_AREA_LABEL_KEYS[area])}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldError />
              </Field>
            )}
          </form.Field>
        </div>

        <form.Field name="title">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t("feedback.subject")}</FieldLabel>
              <Input
                autoFocus
                maxLength={FEEDBACK_LIMITS.title}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={t("feedback.subjectPlaceholder")}
                required
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>

        <form.Field name="whatHappened">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t("feedback.whatHappened")}</FieldLabel>
              <Textarea
                maxLength={FEEDBACK_LIMITS.whatHappened}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={t("feedback.whatHappenedPlaceholder")}
                required
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>

        <form.Field name="steps">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t("feedback.steps")}</FieldLabel>
              <Textarea
                maxLength={FEEDBACK_LIMITS.steps}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={t("feedback.stepsPlaceholder")}
                value={field.state.value}
              />
              <FieldDescription>{t("feedback.stepsHint")}</FieldDescription>
              <FieldError />
            </Field>
          )}
        </form.Field>

        <div className="text-muted-foreground flex flex-col gap-1 text-xs">
          <p className="text-pretty">{t("feedback.privacyNote")}</p>
          <p>
            {t.rich("feedback.included", {
              bdi: (chunks) => (
                <bdi className="font-mono" dir="ltr">
                  {chunks}
                </bdi>
              ),
              route,
              version: __APP_VERSION__,
            })}
          </p>
        </div>
      </DialogPanel>
      <DialogFooter className="sm:justify-between">
        <CommunityLinks />
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button loading={submit.isPending} type="submit">
            {t("feedback.send")}
          </Button>
        </div>
      </DialogFooter>
    </Form>
  );
};

type FeedbackReceiptProps = {
  onClose: () => void;
  response: FeedbackReceiptView;
};

const FeedbackReceipt = ({ onClose, response }: FeedbackReceiptProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();

  const handleCopy = async () => {
    const copied = await copyToClipboard(response.receipt);
    if (Result.isError(copied)) {
      analytics.captureError(copied.error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    stellaToast.add({ title: t("common.copied"), type: "success" });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("feedback.receiptTitle")}</DialogTitle>
        <DialogDescription>
          {response.deduplicated
            ? t("feedback.receiptDeduplicated")
            : t("feedback.receiptDescription")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-3">
        <div className="border-border bg-muted/40 flex items-center justify-between gap-3 rounded-xl border p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">
              {t("feedback.receiptLabel")}
            </span>
            <bdi className="text-foreground truncate font-mono text-sm">
              {response.receipt}
            </bdi>
          </div>
          <Button
            aria-label={t("feedback.copyReceipt")}
            onClick={() => {
              detached(handleCopy(), "feedback-dialog.copy-receipt");
            }}
            size="icon"
            variant="ghost"
          >
            <CopyIcon />
          </Button>
        </div>
        {response.warning !== undefined && (
          <p className="text-muted-foreground text-xs text-pretty">
            {response.warning}
          </p>
        )}
      </DialogPanel>
      <DialogFooter className="sm:justify-between">
        <CommunityLinks />
        <Button onClick={onClose} variant="outline">
          {t("common.close")}
        </Button>
      </DialogFooter>
    </>
  );
};

const CommunityLinks = () => (
  <div className="flex items-center gap-1">
    {COMMUNITY_CHANNELS.map(({ href, icon: Icon, name }) => (
      <Button
        key={name}
        render={
          <a
            aria-label={name}
            href={sanitizeHref(href)}
            rel="noreferrer"
            target="_blank"
          />
        }
        size="sm"
        variant="ghost"
      >
        <Icon />
        <bdi>{name}</bdi>
      </Button>
    ))}
  </div>
);
