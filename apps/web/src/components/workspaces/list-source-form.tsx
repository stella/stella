import { useForm, useSelector } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { LEGAL_LIST_SOURCE_QUOTE_MAX_LENGTH } from "@stll/api-contract/limits";
import { Button } from "@stll/ui/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { Textarea } from "@stll/ui/textarea";

import { MatterDocumentPicker } from "@/components/workspaces/matter-document-picker";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { PDF_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import {
  entityOptions,
  workspaceFilesOptions,
} from "@/lib/workspaces/queries/entities";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";

export type ListSourceFormProps = {
  workspaceId: string;
  listId: string;
  itemEntityId: string;
  onCreated?: () => void;
  onClose: () => void;
};

export const ListSourceForm = ({
  workspaceId,
  listId,
  itemEntityId,
  onClose,
  onCreated,
}: ListSourceFormProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const filesView = useQueryView(useQuery(workspaceFilesOptions(workspaceId)));
  useQueryViewError(filesView);
  const files = filesView.type === "items" ? filesView.items : [];
  const schema = v.object({
    sourceEntityId: v.pipe(
      v.string(),
      v.nonEmpty(t("lists.sources.documentRequired")),
    ),
    page: v.pipe(
      v.string(),
      v.check(
        (page) =>
          page === "" ||
          (Number.isSafeInteger(Number(page)) && Number(page) >= 1),
        t("lists.sources.invalidPage"),
      ),
    ),
    quote: v.pipe(
      v.string(),
      v.maxLength(
        LEGAL_LIST_SOURCE_QUOTE_MAX_LENGTH,
        t("lists.sources.quoteTooLong", {
          limit: format.number(LEGAL_LIST_SOURCE_QUOTE_MAX_LENGTH),
        }),
      ),
    ),
  });
  const create = useMutation({
    mutationFn: async ({
      sourceEntityId,
      page,
      quote,
    }: v.InferOutput<typeof schema>) => {
      const isPdf =
        files.find((file) => file.entityId === sourceEntityId)?.mimeType ===
        PDF_MIME;
      // Resolve a live version at submission, rather than pinning a stale picker entry.
      const document = await queryClient.query({
        ...entityOptions(workspaceId, sourceEntityId),
        staleTime: 0,
      });
      const listApi = api.lists({
        workspaceId: toSafeId<"workspace">(workspaceId),
      });
      return unwrapEden(
        await listApi["item-sources"].post({
          listId: toSafeId<"legalList">(listId),
          itemEntityId: toSafeId<"entity">(itemEntityId),
          sourceEntityId: document.entityId,
          sourceEntityVersionId: document.currentVersionId,
          locator:
            isPdf && page !== ""
              ? { type: "pdf-page", pageNumber: Number(page) }
              : { type: "document" },
          quote: quote === "" ? null : quote,
        }),
      );
    },
    onSuccess: async () => {
      // Sources, history, and the fact's firstSource all live below this key.
      await queryClient.invalidateQueries({
        queryKey: legalListKeys.items(workspaceId, listId),
      });
      onCreated?.();
      onClose();
    },
    onError: (error) => {
      analytics.captureError(error);
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  const form = useForm(
    schemaFormOptions({
      schema,
      defaultValues: { sourceEntityId: "", page: "", quote: "" },
      submitValues: "schema-output",
      onSubmit: ({ value }) => {
        create.mutate(value);
      },
    }),
  );
  const { sourceEntityId, formErrors, dirty } = useSelector(
    form.store,
    (state) => ({
      sourceEntityId: state.values.sourceEntityId,
      formErrors: toFormErrors(state.fieldMeta),
      dirty: !state.isDefaultValue,
    }),
  );
  const isPdf =
    files.find((file) => file.entityId === sourceEntityId)?.mimeType ===
    PDF_MIME;
  return (
    <Form
      className="space-y-2"
      noValidate
      errors={formErrors}
      dirty={dirty}
      onDiscard={() => form.reset()}
      onSubmit={(event) => {
        event.preventDefault();
        if (create.isPending) {
          return;
        }
        detached(form.handleSubmit(), "list-source.submit");
      }}
    >
      <form.Field name="sourceEntityId">
        {(field) => (
          <Field name={field.name} invalid={field.state.meta.errors.length > 0}>
            <MatterDocumentPicker
              workspaceId={workspaceId}
              pickedEntityIds={
                field.state.value === "" ? [] : [field.state.value]
              }
              maxPicked={1}
              disabled={create.isPending}
              label={t("common.document")}
              onChange={(ids) => {
                field.handleChange(ids.at(0) ?? "");
                form.setFieldValue("page", "");
              }}
            />
            <FieldError role="alert" match={field.state.meta.errors.length > 0}>
              {formErrors?.["sourceEntityId"]}
            </FieldError>
          </Field>
        )}
      </form.Field>
      {isPdf && (
        <form.Field name="page">
          {(field) => (
            <Field
              name={field.name}
              invalid={field.state.meta.errors.length > 0}
            >
              <FieldLabel>{t("lists.sources.page")}</FieldLabel>
              <Input
                inputMode="numeric"
                dir="ltr"
                value={field.state.value}
                disabled={create.isPending}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
              />
              <FieldError
                role="alert"
                match={field.state.meta.errors.length > 0}
              >
                {formErrors?.["page"]}
              </FieldError>
            </Field>
          )}
        </form.Field>
      )}
      <form.Field name="quote">
        {(field) => (
          <Field name={field.name} invalid={field.state.meta.errors.length > 0}>
            <FieldLabel>{t("lists.sources.quote")}</FieldLabel>
            <Textarea
              value={field.state.value}
              disabled={create.isPending}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
            />
            <FieldError role="alert" match={field.state.meta.errors.length > 0}>
              {formErrors?.["quote"]}
            </FieldError>
          </Field>
        )}
      </form.Field>
      <div className="flex gap-2">
        <Button
          className="min-h-11"
          type="submit"
          size="sm"
          loading={create.isPending}
        >
          {t("common.save")}
        </Button>
        <Button
          className="min-h-11"
          type="button"
          size="sm"
          variant="ghost"
          disabled={create.isPending}
          onClick={onClose}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </Form>
  );
};
