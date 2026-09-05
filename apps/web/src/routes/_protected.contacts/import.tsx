import { useRef, useState } from "react";
import type { RefObject } from "react";

import { createFileRoute, Link } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  FileSpreadsheetIcon,
  Loader2Icon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_IGNORE_DESTINATION,
  CONTACT_IMPORT_SCHEMA_VERSION,
  CONTACT_IMPORT_TARGET_FIELDS,
  CONTACT_IMPORT_TAX_ID_SCHEMES,
  CONTACT_TYPES,
  type ContactImportField,
  type ContactImportMapping,
  type ContactImportTargetField,
  type ContactImportTaxIdScheme,
  type ContactType,
} from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { useExternalFileDrop } from "@/hooks/use-external-file-drop";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { contactsKeys } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { pageTitle } from "@/lib/page-title";
import { IMPORT_EDITABLE_FIELDS } from "@/routes/_protected.contacts/-import-candidate";
import type { ImportEditableField } from "@/routes/_protected.contacts/-import-candidate";
import {
  IMPORT_FIELD_LABELS,
  ImportCandidateCard,
  ImportResultsList,
  useImportReview,
} from "@/routes/_protected.contacts/-import-review";
import type { ImportReview } from "@/routes/_protected.contacts/-import-review";

export const Route = createFileRoute("/_protected/contacts/import")({
  head: () => ({
    meta: [{ title: pageTitle("contacts.importStudio.title") }],
  }),
  component: ContactImportStudio,
});

type InspectResponse = Awaited<
  ReturnType<typeof api.contacts.import.inspect.post>
>;

type Inspection = Exclude<
  NonNullable<Extract<InspectResponse, { data: unknown }>["data"]>,
  Response
>;

type StudioState =
  | { status: "upload" }
  | {
      status: "mapping";
      file: File;
      inspection: Inspection;
      mapping: ContactImportMapping;
    }
  | {
      status: "review";
      file: File;
      inspection: Inspection;
      mapping: ContactImportMapping;
    };

type BusyState = "idle" | "inspecting" | "previewing";

const DELIMITER_LABELS = {
  comma: "contacts.importStudio.delimiter.comma",
  semicolon: "contacts.importStudio.delimiter.semicolon",
  tab: "contacts.importStudio.delimiter.tab",
  labeled: "contacts.importStudio.delimiter.labeled",
} as const satisfies Record<Inspection["delimiter"], TranslationKey>;

const TAX_ID_SCHEME_LABELS = {
  none: "contacts.importStudio.taxIdSchemeNone",
  br_cpf_cnpj: "contacts.importStudio.taxIdSchemeBrCpfCnpj",
} as const satisfies Record<ContactImportTaxIdScheme, TranslationKey>;

const STEP_KEYS = [
  "contacts.importStudio.stepUpload",
  "contacts.importStudio.stepMap",
  "knowledge.playbooks.review.run",
  "common.done",
] as const satisfies readonly TranslationKey[];

const isSupportedFile = (file: File): boolean =>
  /\.(?:csv|tsv|txt)$/iu.test(file.name);

const isolateBidi = (value: string): string => `\u2068${value}\u2069`;

const isTargetField = (value: unknown): value is ContactImportTargetField =>
  CONTACT_IMPORT_TARGET_FIELDS.some((field) => field === value);

const isContactType = (value: unknown): value is ContactType =>
  CONTACT_TYPES.some((type) => type === value);

const isTaxIdScheme = (value: unknown): value is ContactImportTaxIdScheme =>
  CONTACT_IMPORT_TAX_ID_SCHEMES.some((scheme) => scheme === value);

const mappingFromInspection = (
  inspection: Inspection,
): ContactImportMapping => ({
  version: CONTACT_IMPORT_SCHEMA_VERSION,
  defaultType: inspection.defaultType,
  generateDisplayName: inspection.generateDisplayName,
  taxIdScheme: inspection.taxIdScheme,
  columns: inspection.columns.map(({ sourceIndex, targetField }) => ({
    sourceIndex,
    targetField,
  })),
});

/**
 * Which inputs a review card offers: whatever the mapping actually fills, plus
 * the two a reviewer always needs (a display name, and the type the tax-id
 * checksum is cross-checked against).
 */
const editableFieldsForMapping = (
  mapping: ContactImportMapping,
): ImportEditableField[] => {
  const mapped = new Set<ContactImportTargetField>(
    mapping.columns.map(({ targetField }) => targetField),
  );
  return IMPORT_EDITABLE_FIELDS.filter(
    (field) =>
      field === "type" ||
      field === "display_name" ||
      mapped.has(field) ||
      (field === "tax_id" && mapping.taxIdScheme !== "none"),
  );
};

const currentStep = (state: StudioState, hasResults: boolean): number => {
  switch (state.status) {
    case "upload":
      return 0;
    case "mapping":
      return 1;
    case "review":
      return hasResults ? 3 : 2;
    default: {
      state satisfies never;
      return panic(`Unhandled state: ${String(state)}`);
    }
  }
};

function ContactImportStudio() {
  const t = useTranslations();
  const format = useFormatter();
  const queryClient = Route.useRouteContext({
    select: ({ queryClient: client }) => client,
  });
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<StudioState>({ status: "upload" });
  const [busy, setBusy] = useState<BusyState>("idle");
  const review = useImportReview({
    onImported: async () => {
      await queryClient.invalidateQueries({ queryKey: contactsKeys.all });
    },
  });

  const focusStepHeading = () => {
    requestAnimationFrame(() => stepHeadingRef.current?.focus());
  };

  const inspectFile = async (file: File) => {
    if (!isSupportedFile(file)) {
      stellaToast.add({
        title: t("contacts.importStudio.fileInvalid"),
        type: "error",
      });
      return;
    }

    setBusy("inspecting");
    const result = await Result.tryPromise(async () => {
      const response = await api.contacts.import.inspect.post({ file });
      return unwrapEden(response);
    });
    setBusy("idle");

    if (Result.isError(result)) {
      stellaToast.add({
        title: userErrorFromThrown(
          result.error,
          t("contacts.importStudio.inspectFailed"),
        ),
        type: "error",
      });
      return;
    }

    setState({
      status: "mapping",
      file,
      inspection: result.value,
      mapping: mappingFromInspection(result.value),
    });
    focusStepHeading();
  };

  const updateMapping = (mapping: ContactImportMapping) => {
    if (state.status !== "mapping") {
      return;
    }
    setState({
      status: "mapping",
      file: state.file,
      inspection: state.inspection,
      mapping,
    });
  };

  const buildPreview = async () => {
    if (state.status !== "mapping") {
      return;
    }
    setBusy("previewing");
    const result = await Result.tryPromise(async () => {
      const response = await api.contacts.import.preview.post({
        file: state.file,
        mapping: JSON.stringify(state.mapping),
      });
      return unwrapEden(response);
    });
    setBusy("idle");

    if (Result.isError(result)) {
      stellaToast.add({
        title: userErrorFromThrown(
          result.error,
          t("contacts.importStudio.previewFailed"),
        ),
        type: "error",
      });
      return;
    }

    review.seed({
      taxIdScheme: state.mapping.taxIdScheme,
      rows: result.value.rows.map(({ contact, issues, rowNumber }) => ({
        candidate: contact,
        issues,
        rowNumber,
      })),
    });
    setState({
      status: "review",
      file: state.file,
      inspection: state.inspection,
      mapping: state.mapping,
    });
    focusStepHeading();
  };

  const goBack = () => {
    if (state.status === "review") {
      review.reset();
      setState({
        status: "mapping",
        file: state.file,
        inspection: state.inspection,
        mapping: state.mapping,
      });
      focusStepHeading();
      return;
    }
    setState({ status: "upload" });
    focusStepHeading();
  };

  const restart = () => {
    review.reset();
    setState({ status: "upload" });
    focusStepHeading();
  };

  const step = currentStep(state, review.results !== null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t">
      <header className="border-b px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold">
              {t("contacts.importStudio.title")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("contacts.importStudio.description")}
            </p>
          </div>
          <ol
            aria-label={t("contacts.importStudio.title")}
            className="grid grid-cols-4 gap-2"
          >
            {STEP_KEYS.map((key, index) => (
              <li
                aria-current={index === step ? "step" : undefined}
                className={cn(
                  "border-muted border-t-2 pt-2 text-sm",
                  index <= step && "border-foreground font-medium",
                  index !== step && "text-muted-foreground",
                )}
                key={key}
              >
                <span className="me-1 tabular-nums">
                  {format.number(index + 1)}.
                </span>
                {t(key)}
              </li>
            ))}
          </ol>
        </div>
      </header>

      <main
        aria-busy={busy !== "idle"}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6",
          state.status === "upload" && "flex flex-col p-4 sm:p-6",
        )}
      >
        {state.status === "upload" && (
          <UploadStep
            busy={busy}
            onFile={(file) => {
              detached(inspectFile(file), "contact-import-studio.inspect");
            }}
            stepHeadingRef={stepHeadingRef}
          />
        )}
        {state.status === "mapping" && (
          <div className="mx-auto max-w-6xl">
            <MappingStep
              busy={busy}
              onMappingChange={updateMapping}
              state={state}
              stepHeadingRef={stepHeadingRef}
            />
          </div>
        )}
        {state.status === "review" && (
          <div className="mx-auto max-w-6xl">
            <ReviewStep
              fields={editableFieldsForMapping(state.mapping)}
              onRestart={restart}
              review={review}
              stepHeadingRef={stepHeadingRef}
            />
          </div>
        )}
      </main>

      {state.status !== "upload" && review.results === null && (
        <footer className="bg-background border-t px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <Button disabled={busy !== "idle"} onClick={goBack} variant="ghost">
              <DirectionalIcon icon={ArrowLeftIcon} />
              {t("common.back")}
            </Button>
            {state.status === "mapping" && (
              <Button
                loading={busy === "previewing"}
                onClick={() =>
                  detached(buildPreview(), "contact-import-studio.preview")
                }
              >
                {t("contacts.importStudio.preview")}
                <DirectionalIcon icon={ArrowRightIcon} />
              </Button>
            )}
            {state.status === "review" && (
              <Button
                disabled={!review.canImport}
                loading={review.isImporting}
                onClick={() =>
                  detached(review.commit(), "contact-import-studio.commit")
                }
              >
                {t("contacts.importStudio.importCount", {
                  count: review.validCount,
                })}
              </Button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

type StepHeadingRef = RefObject<HTMLHeadingElement | null>;

const UploadStep = ({
  busy,
  onFile,
  stepHeadingRef,
}: {
  busy: BusyState;
  onFile: (file: File) => void;
  stepHeadingRef: StepHeadingRef;
}) => {
  const t = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isInspecting = busy === "inspecting";
  const { ref, isDropTarget } = useExternalFileDrop({
    onDrop: (files) => {
      const file = files.at(0);
      if (files.length !== 1 || !file) {
        stellaToast.add({
          title: t("contacts.importStudio.fileInvalid"),
          type: "error",
        });
        return;
      }
      onFile(file);
    },
    enabled: !isInspecting,
  });

  // The whole step is the drop target: the section fills the main area and
  // the button stretches with it, so any drop on the screen counts.
  return (
    <section className="flex min-h-0 flex-1 flex-col" ref={ref}>
      <h2 className="sr-only" ref={stepHeadingRef} tabIndex={-1}>
        {t("contacts.importStudio.stepUpload")}
      </h2>
      <button
        aria-busy={isInspecting}
        className={cn(
          "focus-visible:ring-ring flex min-h-72 w-full flex-1 flex-col items-center justify-center gap-3 rounded-xl p-8 text-center transition-colors focus-visible:ring-2 focus-visible:outline-none",
          isDropTarget &&
            "bg-primary/5 outline-primary/40 outline-2 -outline-offset-8 outline-dashed",
          isInspecting && "cursor-progress",
        )}
        disabled={isInspecting}
        onClick={() => fileInputRef.current?.click()}
        type="button"
      >
        {isInspecting ? (
          <Loader2Icon className="text-muted-foreground size-10 animate-spin" />
        ) : (
          <FileSpreadsheetIcon className="text-muted-foreground size-10" />
        )}
        <span className="font-medium">
          {t("contacts.importStudio.dropFile")}
        </span>
        <span className="text-muted-foreground text-sm">
          {t("contacts.importStudio.supportedFiles")}
        </span>
        <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <UploadIcon className="size-4" />
          {t("contacts.importStudio.chooseFile")}
        </span>
      </button>
      <input
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        className="hidden"
        onChange={(event) => {
          const selected = event.target.files?.item(0);
          event.target.value = "";
          if (selected) {
            onFile(selected);
          }
        }}
        ref={fileInputRef}
        type="file"
      />
    </section>
  );
};

type MappingState = Extract<StudioState, { status: "mapping" }>;

const MappingStep = ({
  state,
  busy,
  onMappingChange,
  stepHeadingRef,
}: {
  state: MappingState;
  busy: BusyState;
  onMappingChange: (mapping: ContactImportMapping) => void;
  stepHeadingRef: StepHeadingRef;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const { mapping } = state;
  const assigned = new Map<ContactImportField, number>(
    mapping.columns.flatMap(({ sourceIndex, targetField }) =>
      targetField === CONTACT_IMPORT_IGNORE_DESTINATION ||
      targetField === CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION
        ? []
        : [[targetField, sourceIndex]],
    ),
  );

  const withColumns = (sourceIndex: number, target: ContactImportTargetField) =>
    onMappingChange({
      ...mapping,
      columns: mapping.columns.map((column) =>
        column.sourceIndex === sourceIndex
          ? { sourceIndex, targetField: target }
          : column,
      ),
    });

  return (
    <section className="space-y-4">
      <div>
        <h2
          className="text-lg font-semibold outline-none"
          ref={stepHeadingRef}
          tabIndex={-1}
        >
          {t("contacts.importStudio.stepMap")}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t("contacts.importStudio.mapDescription")}
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          <span className="sr-only">
            {t("contacts.importStudio.fileSummary", {
              name: isolateBidi(state.file.name),
              count: state.inspection.rowCount,
            })}
          </span>
          <span aria-hidden="true" className="flex items-center gap-1">
            <BidiText>{state.file.name}</BidiText>
            <span>·</span>
            <span className="tabular-nums">
              {format.number(state.inspection.rowCount)}
            </span>
            <span>·</span>
            <span>{t(DELIMITER_LABELS[state.inspection.delimiter])}</span>
          </span>
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("contacts.importStudio.sourceColumn")}</TableHead>
            <TableHead>{t("contacts.importStudio.sampleValues")}</TableHead>
            <TableHead>{t("contacts.importStudio.stellaField")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.inspection.columns.map((column) => {
            const columnMapping = mapping.columns.find(
              ({ sourceIndex }) => sourceIndex === column.sourceIndex,
            );
            const targetField =
              columnMapping?.targetField ?? CONTACT_IMPORT_IGNORE_DESTINATION;
            return (
              <TableRow key={column.sourceIndex}>
                <TableCell className="font-medium">
                  <BidiText>{column.name}</BidiText>
                </TableCell>
                <TableCell className="text-muted-foreground max-w-96">
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {column.samples.map((sample) => (
                      <BidiText className="truncate" key={sample}>
                        {sample}
                      </BidiText>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Select
                    disabled={busy !== "idle"}
                    onValueChange={(value) => {
                      if (isTargetField(value)) {
                        withColumns(column.sourceIndex, value);
                      }
                    }}
                    value={targetField}
                  >
                    <SelectTrigger
                      aria-label={`${isolateBidi(column.name)}: ${t("contacts.importStudio.stellaField")}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={CONTACT_IMPORT_IGNORE_DESTINATION}>
                        {t("contacts.importStudio.ignore")}
                      </SelectItem>
                      <SelectItem
                        value={CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION}
                      >
                        {t("contacts.importStudio.customFieldTarget")}
                      </SelectItem>
                      {CONTACT_IMPORT_FIELDS.map((field) => (
                        <SelectItem
                          disabled={
                            assigned.has(field) &&
                            assigned.get(field) !== column.sourceIndex
                          }
                          key={field}
                          value={field}
                        >
                          {t(IMPORT_FIELD_LABELS[field])}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label
            className="text-sm font-medium"
            htmlFor="contact-import-default-type"
          >
            {t("contacts.importStudio.defaultType")}
          </label>
          <Select
            disabled={busy !== "idle"}
            onValueChange={(value) => {
              if (isContactType(value)) {
                onMappingChange({ ...mapping, defaultType: value });
              }
            }}
            value={mapping.defaultType}
          >
            <SelectTrigger id="contact-import-default-type">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {CONTACT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(`contacts.type.${type}`)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-2">
          <label
            className="text-sm font-medium"
            htmlFor="contact-import-tax-id-scheme"
          >
            {t("contacts.importStudio.taxIdScheme")}
          </label>
          <Select
            disabled={busy !== "idle"}
            onValueChange={(value) => {
              if (isTaxIdScheme(value)) {
                onMappingChange({ ...mapping, taxIdScheme: value });
              }
            }}
            value={mapping.taxIdScheme}
          >
            <SelectTrigger id="contact-import-tax-id-scheme">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {CONTACT_IMPORT_TAX_ID_SCHEMES.map((scheme) => (
                <SelectItem key={scheme} value={scheme}>
                  {t(TAX_ID_SCHEME_LABELS[scheme])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <Checkbox
          checked={mapping.generateDisplayName}
          disabled={busy !== "idle"}
          onCheckedChange={(generateDisplayName) =>
            onMappingChange({ ...mapping, generateDisplayName })
          }
        />
        {t("contacts.importStudio.generateDisplayName")}
      </label>
    </section>
  );
};

const ReviewStep = ({
  fields,
  onRestart,
  review,
  stepHeadingRef,
}: {
  fields: readonly ImportEditableField[];
  onRestart: () => void;
  review: ImportReview;
  stepHeadingRef: StepHeadingRef;
}) => {
  const t = useTranslations();
  const { results } = review;

  if (results) {
    return (
      <section className="space-y-4">
        <div>
          <h2
            className="text-lg font-semibold outline-none"
            ref={stepHeadingRef}
            tabIndex={-1}
          >
            {t("common.done")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("contacts.import.resultsSummary", {
              created: results.filter(({ status }) => status === "created")
                .length,
              skipped: results.filter(({ status }) => status === "skipped")
                .length,
            })}
          </p>
        </div>
        <ImportResultsList results={results} />
        <div className="flex flex-wrap gap-2 pt-2">
          <Button render={<Link to="/contacts" />}>
            {t("contacts.importStudio.openContacts")}
          </Button>
          <Button onClick={onRestart} variant="outline">
            {t("contacts.importStudio.importAnother")}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div>
        <h2
          className="text-lg font-semibold outline-none"
          ref={stepHeadingRef}
          tabIndex={-1}
        >
          {t("knowledge.playbooks.review.run")}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t("contacts.importStudio.reviewDescription")}
        </p>
      </div>
      <ImportReviewSummary review={review} />
      <div className="space-y-3">
        {review.rows.map((row, index) => (
          <ImportCandidateCard
            fields={fields}
            key={row.id}
            onChange={(candidate) => review.updateRow(row.id, candidate)}
            onRemove={() => review.removeRow(row.id)}
            ordinal={index + 1}
            row={row}
          />
        ))}
      </div>
    </section>
  );
};

const ImportSummaryIcon = ({
  errorCount,
  isPending,
}: {
  errorCount: number;
  isPending: boolean;
}) => {
  if (isPending) {
    return (
      <Loader2Icon className="text-muted-foreground size-4 shrink-0 animate-spin" />
    );
  }
  if (errorCount > 0) {
    return <AlertTriangleIcon className="text-destructive size-4 shrink-0" />;
  }
  return <CheckCircle2Icon className="text-success size-4 shrink-0" />;
};

/** The one live verdict over the whole batch: ready, faulty, or unchecked. */
const ImportReviewSummary = ({ review }: { review: ImportReview }) => {
  const t = useTranslations();
  const { errorCount, validation, validCount } = review;

  if (validation.status === "failed") {
    return (
      <div
        aria-live="polite"
        className="border-destructive/40 bg-destructive/5 flex items-center gap-2 rounded-lg border p-3 text-sm"
        role="status"
      >
        <AlertTriangleIcon className="text-destructive size-4 shrink-0" />
        <span>{validation.message}</span>
      </div>
    );
  }

  return (
    <div
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 rounded-lg border p-3 text-sm",
        errorCount > 0 && "border-destructive/40 bg-destructive/5",
      )}
      role="status"
    >
      <ImportSummaryIcon
        errorCount={errorCount}
        isPending={validation.status === "pending"}
      />
      <span>
        {t("contacts.importStudio.reviewSummary", {
          errors: errorCount,
          ready: validCount,
        })}
      </span>
    </div>
  );
};
