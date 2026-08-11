import { useRef, useState } from "react";
import type { RefObject } from "react";

import { useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  getRouteApi,
  Link,
  useNavigate,
} from "@tanstack/react-router";
import { Result } from "better-result";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  FileSpreadsheetIcon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_IGNORE_DESTINATION,
  CONTACT_IMPORT_ISSUE_CODE,
  CONTACT_IMPORT_SCHEMA_VERSION,
  CONTACT_IMPORT_TARGET_FIELDS,
  type ContactImportField,
  type ContactImportIssueCode,
  type ContactImportMapping,
  type ContactImportTargetField,
} from "@stll/api-contract";
import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { FileDropZone } from "@/components/file-drop-zone";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { contactsKeys } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { pageTitle } from "@/lib/page-title";
import {
  clearContactImportRequest,
  resolveContactImportRequest,
} from "@/routes/_protected.contacts/-contact-import-request";
import type { PendingContactImportRequest } from "@/routes/_protected.contacts/-contact-import-request";

export const Route = createFileRoute("/_protected/contacts/import")({
  head: () => ({
    meta: [{ title: pageTitle("contacts.importStudio.title") }],
  }),
  component: ContactImportStudio,
});

const protectedRouteApi = getRouteApi("/_protected");

type InspectionColumn = {
  name: string;
  samples: string[];
  sourceIndex: number;
  targetField: ContactImportTargetField;
};

type Inspection = {
  columns: InspectionColumn[];
  defaultType: "person" | "organization";
  generateDisplayName: boolean;
  rowCount: number;
};

type PreviewIssue = {
  code: ContactImportIssueCode;
  field: ContactImportField | null;
  rowNumber: number;
};

type PreviewRow = {
  contact: {
    type: "person" | "organization";
    displayName: string;
    primaryEmail: string | null;
  };
  issues: PreviewIssue[];
  rowNumber: number;
};

type Preview = {
  errorCount: number;
  rows: PreviewRow[];
  validCount: number;
};

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
      preview: Preview;
      importRequest: PendingContactImportRequest;
    };

type BusyState = "idle" | "inspecting" | "previewing" | "importing";

const FIELD_LABELS = {
  type: "contacts.importStudio.fields.type",
  display_name: "common.displayName",
  prefix: "contacts.importStudio.fields.prefix",
  first_name: "contacts.importStudio.fields.first_name",
  middle_name: "contacts.importStudio.fields.middle_name",
  last_name: "contacts.importStudio.fields.last_name",
  suffix: "contacts.importStudio.fields.suffix",
  organization_name: "common.organizationName",
  primary_email: "contacts.importStudio.fields.primary_email",
  primary_phone: "contacts.importStudio.fields.primary_phone",
  address_line_1: "contacts.importStudio.fields.address_line_1",
  address_line_2: "contacts.importStudio.fields.address_line_2",
  city: "contacts.importStudio.fields.city",
  state: "contacts.importStudio.fields.state",
  postal_code: "contacts.importStudio.fields.postal_code",
  country: "common.country",
  notes: "common.notes",
  tags: "templates.tags",
  registration_number: "contacts.fields.registrationNumber",
  tax_id: "contacts.importStudio.fields.tax_id",
} as const satisfies Record<ContactImportField, TranslationKey>;

const ISSUE_LABELS = {
  [CONTACT_IMPORT_ISSUE_CODE.ADDRESS_LINE_REQUIRED]:
    "contacts.importStudio.issue.address_line_required",
  [CONTACT_IMPORT_ISSUE_CODE.DISPLAY_NAME_REQUIRED]:
    "contacts.importStudio.issue.display_name_required",
  [CONTACT_IMPORT_ISSUE_CODE.INVALID_EMAIL]:
    "contacts.importStudio.issue.invalid_email",
  [CONTACT_IMPORT_ISSUE_CODE.INVALID_PHONE]:
    "contacts.importStudio.issue.invalid_phone",
  [CONTACT_IMPORT_ISSUE_CODE.INVALID_TAGS]:
    "contacts.importStudio.issue.invalid_tags",
  [CONTACT_IMPORT_ISSUE_CODE.INVALID_TYPE]:
    "contacts.importStudio.issue.invalid_type",
  [CONTACT_IMPORT_ISSUE_CODE.ROW_LENGTH_MISMATCH]:
    "contacts.importStudio.issue.row_length_mismatch",
  [CONTACT_IMPORT_ISSUE_CODE.TOO_LONG]: "contacts.importStudio.issue.too_long",
  [CONTACT_IMPORT_ISSUE_CODE.TOO_MANY_TAGS]:
    "contacts.importStudio.issue.too_many_tags",
} as const satisfies Record<ContactImportIssueCode, TranslationKey>;

const STEP_KEYS = [
  "contacts.importStudio.stepUpload",
  "contacts.importStudio.stepMap",
  "knowledge.playbooks.review.run",
] as const satisfies readonly TranslationKey[];

const isSupportedFile = (file: File): boolean =>
  /\.(?:csv|tsv)$/iu.test(file.name);

const isolateBidi = (value: string): string => `\u2068${value}\u2069`;

const isTargetField = (value: unknown): value is ContactImportTargetField =>
  CONTACT_IMPORT_TARGET_FIELDS.some((field) => field === value);

const mappingFromInspection = (
  inspection: Inspection,
): ContactImportMapping => ({
  version: CONTACT_IMPORT_SCHEMA_VERSION,
  defaultType: inspection.defaultType,
  generateDisplayName: inspection.generateDisplayName,
  columns: inspection.columns.map(({ sourceIndex, targetField }) => ({
    sourceIndex,
    targetField,
  })),
});

const currentStep = (status: StudioState["status"]): number => {
  switch (status) {
    case "upload":
      return 0;
    case "mapping":
      return 1;
    case "review":
      return 2;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

function ContactImportStudio() {
  const t = useTranslations();
  const format = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const importRequestScope = protectedRouteApi.useRouteContext({
    select: ({ user }) => ({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }),
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<StudioState>({ status: "upload" });
  const [busy, setBusy] = useState<BusyState>("idle");

  const focusStepHeading = () => {
    requestAnimationFrame(() => stepHeadingRef.current?.focus());
  };

  const inspectFile = async (files: File[]) => {
    const file = files.at(0);
    if (files.length !== 1 || !file || !isSupportedFile(file)) {
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

    const inspection = result.value;
    setState({
      status: "mapping",
      file,
      inspection,
      mapping: mappingFromInspection(inspection),
    });
    focusStepHeading();
  };

  const updateMapping = (
    sourceIndex: number,
    targetField: ContactImportTargetField,
  ) => {
    if (state.status !== "mapping") {
      return;
    }
    const columns = state.mapping.columns.map((column) =>
      column.sourceIndex === sourceIndex
        ? { sourceIndex, targetField }
        : column,
    );
    setState({
      status: "mapping",
      file: state.file,
      inspection: state.inspection,
      mapping: {
        version: CONTACT_IMPORT_SCHEMA_VERSION,
        defaultType: state.mapping.defaultType,
        generateDisplayName: state.mapping.generateDisplayName,
        columns,
      },
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
      const preview = unwrapEden(response);
      const importRequest = await resolveContactImportRequest({
        file: state.file,
        mapping: state.mapping,
        scope: importRequestScope,
      });
      return { importRequest, preview };
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

    setState({
      status: "review",
      file: state.file,
      inspection: state.inspection,
      mapping: state.mapping,
      preview: result.value.preview,
      importRequest: result.value.importRequest,
    });
    focusStepHeading();
  };

  const commitImport = async () => {
    if (
      state.status !== "review" ||
      state.preview.errorCount > 0 ||
      state.preview.validCount === 0
    ) {
      return;
    }
    setBusy("importing");
    const result = await Result.tryPromise(async () => {
      const response = await api.contacts.import.post({
        file: state.file,
        importRequestId: state.importRequest.id,
        mapping: JSON.stringify(state.mapping),
      });
      return unwrapEden(response);
    });
    setBusy("idle");

    if (Result.isError(result)) {
      stellaToast.add({
        title: userErrorFromThrown(
          result.error,
          t("contacts.importStudio.importFailed"),
        ),
        type: "error",
      });
      return;
    }

    stellaToast.add({
      title: t("contacts.importStudio.importSuccess", {
        count: result.value.created,
      }),
      type: "success",
    });
    clearContactImportRequest({ storageKey: state.importRequest.storageKey });
    await queryClient.invalidateQueries({ queryKey: contactsKeys.all });
    await navigate({ to: "/contacts" });
  };

  const goBack = () => {
    if (state.status === "review") {
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

  const step = currentStep(state.status);

  return (
    <FileDropZone
      className="overflow-hidden border-t"
      enabled={state.status === "upload" && busy === "idle"}
      label={t("contacts.importStudio.dropFile")}
      onDrop={(files) => {
        detached(inspectFile(files), "ContactImportStudio.drop");
      }}
    >
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
            className="grid grid-cols-3 gap-2"
            aria-label={t("contacts.importStudio.title")}
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
        className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"
        aria-busy={busy !== "idle"}
      >
        <div className="mx-auto max-w-6xl">
          {state.status === "upload" && (
            <section className="mx-auto max-w-2xl">
              <h2 className="sr-only" ref={stepHeadingRef} tabIndex={-1}>
                {t("contacts.importStudio.stepUpload")}
              </h2>
              <div className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-8 text-center">
                <FileSpreadsheetIcon className="text-muted-foreground size-10" />
                <div>
                  <p className="font-medium">
                    {t("contacts.importStudio.dropFile")}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {t("contacts.importStudio.supportedFiles")}
                  </p>
                </div>
                <Button
                  loading={busy === "inspecting"}
                  onClick={() => fileInputRef.current?.click()}
                  variant="outline"
                >
                  <UploadIcon />
                  {t("contacts.importStudio.chooseFile")}
                </Button>
                <input
                  accept=".csv,.tsv,text/csv,text/tab-separated-values"
                  className="hidden"
                  onChange={(event) => {
                    const selected = event.target.files?.item(0);
                    event.target.value = "";
                    if (selected) {
                      detached(
                        inspectFile([selected]),
                        "ContactImportStudio.picker",
                      );
                    }
                  }}
                  ref={fileInputRef}
                  type="file"
                />
              </div>
            </section>
          )}

          {state.status === "mapping" && (
            <MappingStep
              busy={busy}
              onDefaultTypeChange={(defaultType) => {
                setState({
                  status: "mapping",
                  file: state.file,
                  inspection: state.inspection,
                  mapping: {
                    version: CONTACT_IMPORT_SCHEMA_VERSION,
                    defaultType,
                    generateDisplayName: state.mapping.generateDisplayName,
                    columns: state.mapping.columns,
                  },
                });
              }}
              onGenerateDisplayNameChange={(generateDisplayName) => {
                setState({
                  status: "mapping",
                  file: state.file,
                  inspection: state.inspection,
                  mapping: {
                    version: CONTACT_IMPORT_SCHEMA_VERSION,
                    defaultType: state.mapping.defaultType,
                    generateDisplayName,
                    columns: state.mapping.columns,
                  },
                });
              }}
              onMappingChange={updateMapping}
              state={state}
              stepHeadingRef={stepHeadingRef}
            />
          )}

          {state.status === "review" && (
            <ReviewStep state={state} stepHeadingRef={stepHeadingRef} />
          )}
        </div>
      </main>

      <footer className="bg-background border-t px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          {state.status === "upload" ? (
            <Button render={<Link to="/contacts" />} variant="ghost">
              <DirectionalIcon icon={ArrowLeftIcon} />
              {t("contacts.importStudio.backToContacts")}
            </Button>
          ) : (
            <Button disabled={busy !== "idle"} onClick={goBack} variant="ghost">
              <DirectionalIcon icon={ArrowLeftIcon} />
              {t("common.back")}
            </Button>
          )}
          {state.status === "mapping" && (
            <Button
              loading={busy === "previewing"}
              onClick={() =>
                detached(buildPreview(), "ContactImportStudio.preview")
              }
            >
              {t("contacts.importStudio.preview")}
              <DirectionalIcon icon={ArrowRightIcon} />
            </Button>
          )}
          {state.status === "review" && (
            <Button
              disabled={
                state.preview.errorCount > 0 || state.preview.validCount === 0
              }
              loading={busy === "importing"}
              onClick={() =>
                detached(commitImport(), "ContactImportStudio.import")
              }
            >
              {t("contacts.importStudio.importCount", {
                count: state.preview.validCount,
              })}
            </Button>
          )}
        </div>
      </footer>
    </FileDropZone>
  );
}

type MappingState = Extract<StudioState, { status: "mapping" }>;

const MappingStep = ({
  state,
  busy,
  onDefaultTypeChange,
  onMappingChange,
  onGenerateDisplayNameChange,
  stepHeadingRef,
}: {
  state: MappingState;
  busy: BusyState;
  onDefaultTypeChange: (type: "person" | "organization") => void;
  onMappingChange: (
    sourceIndex: number,
    targetField: ContactImportTargetField,
  ) => void;
  onGenerateDisplayNameChange: (checked: boolean) => void;
  stepHeadingRef: RefObject<HTMLHeadingElement | null>;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const assigned = new Map(
    state.mapping.columns.map(({ sourceIndex, targetField }) => [
      targetField,
      sourceIndex,
    ]),
  );

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
            const mapping = state.mapping.columns.find(
              ({ sourceIndex }) => sourceIndex === column.sourceIndex,
            );
            const targetField =
              mapping?.targetField ?? CONTACT_IMPORT_IGNORE_DESTINATION;
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
                        onMappingChange(column.sourceIndex, value);
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
                      {CONTACT_IMPORT_FIELDS.map((field) => (
                        <SelectItem
                          disabled={
                            assigned.has(field) &&
                            assigned.get(field) !== column.sourceIndex
                          }
                          key={field}
                          value={field}
                        >
                          {t(FIELD_LABELS[field])}
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
      <div className="max-w-md space-y-2">
        <label
          className="text-sm font-medium"
          htmlFor="contact-import-default-type"
        >
          {t("contacts.importStudio.defaultType")}
        </label>
        <Select
          disabled={busy !== "idle"}
          onValueChange={(value) => {
            if (value === "person" || value === "organization") {
              onDefaultTypeChange(value);
            }
          }}
          value={state.mapping.defaultType}
        >
          <SelectTrigger id="contact-import-default-type">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="person">{t("contacts.type.person")}</SelectItem>
            <SelectItem value="organization">
              {t("contacts.type.organization")}
            </SelectItem>
          </SelectPopup>
        </Select>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <Checkbox
          checked={state.mapping.generateDisplayName}
          disabled={busy !== "idle"}
          onCheckedChange={onGenerateDisplayNameChange}
        />
        {t("contacts.importStudio.generateDisplayName")}
      </label>
    </section>
  );
};

type ReviewState = Extract<StudioState, { status: "review" }>;

const ReviewStep = ({
  state,
  stepHeadingRef,
}: {
  state: ReviewState;
  stepHeadingRef: RefObject<HTMLHeadingElement | null>;
}) => {
  const t = useTranslations();
  const format = useFormatter();

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
      <div
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 rounded-lg border p-3 text-sm",
          state.preview.errorCount > 0 &&
            "border-destructive/40 bg-destructive/5",
        )}
        role="status"
      >
        {state.preview.errorCount > 0 ? (
          <AlertTriangleIcon className="text-destructive size-4 shrink-0" />
        ) : (
          <CheckCircle2Icon className="text-success size-4 shrink-0" />
        )}
        <span>
          {t("contacts.importStudio.reviewSummary", {
            ready: state.preview.validCount,
            errors: state.preview.errorCount,
          })}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("contacts.importStudio.row")}</TableHead>
            <TableHead>{t("common.name")}</TableHead>
            <TableHead>{t("common.email")}</TableHead>
            <TableHead>{t("contacts.importStudio.fields.type")}</TableHead>
            <TableHead>{t("common.status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.preview.rows.map((row) => (
            <TableRow
              className={cn(row.issues.length > 0 && "bg-destructive/5")}
              key={row.rowNumber}
            >
              <TableCell className="tabular-nums">
                {format.number(row.rowNumber)}
              </TableCell>
              <TableCell className="font-medium">
                <BidiText>{row.contact.displayName}</BidiText>
              </TableCell>
              <TableCell className="[direction:ltr]">
                {row.contact.primaryEmail}
              </TableCell>
              <TableCell>{t(`contacts.type.${row.contact.type}`)}</TableCell>
              <TableCell>
                {row.issues.length === 0 ? (
                  <span className="text-success flex items-center gap-1.5">
                    <CheckCircle2Icon className="size-4" />
                    {t("contacts.importStudio.ready")}
                  </span>
                ) : (
                  <ul className="text-destructive space-y-1">
                    {row.issues.map((issue) => (
                      <li
                        className="flex items-start gap-1.5"
                        key={`${issue.code}-${issue.field ?? "row"}`}
                      >
                        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          {t(ISSUE_LABELS[issue.code])}
                          {issue.field && (
                            <span className="text-muted-foreground ms-1">
                              ({t(FIELD_LABELS[issue.field])})
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
};
