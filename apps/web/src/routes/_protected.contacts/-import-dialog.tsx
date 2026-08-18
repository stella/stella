import { useRef, useState } from "react";
import type { RefObject } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckIcon, UploadIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { useImportContacts } from "@/lib/contacts/mutations";
import { contactsKeys } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import {
  applyContactImportMapping,
  assignStableImportIds,
  contactImportTextFileIssue,
  parseContactImportText,
  toImportRowVars,
  validateRows,
} from "@/routes/_protected.contacts/-parse-import";
import type {
  ImportFieldError,
  LabeledImportMapping,
  ParsedImportFieldKey,
  ParsedImportRow,
} from "@/routes/_protected.contacts/-parse-import";

type ImportContactsMutation = ReturnType<typeof useImportContacts>;
export type ImportContactResult = Awaited<
  ReturnType<ImportContactsMutation["mutateAsync"]>
>[number];

export const FIELD_CONFIG = [
  { key: "nome", labelKey: "contacts.create.contactName" },
  { key: "taxId", labelKey: "contacts.fields.taxId" },
  { key: "rg", labelKey: "contacts.import.fields.rg" },
  { key: "nacionalidade", labelKey: "contacts.import.fields.nacionalidade" },
  { key: "estadoCivil", labelKey: "contacts.import.fields.estadoCivil" },
  { key: "uniaoEstavel", labelKey: "contacts.import.fields.uniaoEstavel" },
  { key: "profissao", labelKey: "contacts.import.fields.profissao" },
  { key: "email", labelKey: "common.email" },
  { key: "endereco", labelKey: "common.anonymizationLabels.address" },
] as const satisfies { key: ParsedImportFieldKey; labelKey: TranslationKey }[];

export const FIELD_ERROR_MESSAGE_KEY = {
  required: "common.required",
  recommendedMissing: "contacts.import.errors.recommendedMissing",
  invalidTaxIdLength: "contacts.import.errors.invalidTaxIdLength",
  invalidEmailFormat: "contacts.import.errors.invalidEmailFormat",
} as const satisfies Record<
  Exclude<ImportFieldError["code"], "duplicateTaxIdInFile">,
  TranslationKey
>;

type SkippedResult = Extract<ImportContactResult, { status: "skipped" }>;

const SKIP_REASON_MESSAGE_KEY = {
  duplicate_contact_id: "contacts.import.skippedDuplicateContactId",
  duplicate_tax_id: "contacts.import.skippedDuplicateTaxId",
  invalid_tax_id: "contacts.import.skippedInvalidTaxId",
  contacts_limit_reached: "contacts.import.skippedLimitReached",
} as const satisfies Record<SkippedResult["reason"], TranslationKey>;

type ImportContactsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type UnrecognizedImportLabel = {
  label: string;
  normalizedLabel: string;
  sample: string;
};

export const ImportContactsDialog = ({
  open,
  onOpenChange,
}: ImportContactsDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importContacts = useImportContacts();

  const [rows, setRows] = useState<ParsedImportRow[]>([]);
  const [results, setResults] = useState<ImportContactResult[] | null>(null);
  const [importRequestId, setImportRequestId] =
    useState<SafeId<"contactImportRequest"> | null>(null);
  const [sourceText, setSourceText] = useState("");
  const [mapping, setMapping] = useState<LabeledImportMapping>({});

  const reset = () => {
    setRows([]);
    setResults(null);
    setImportRequestId(null);
    setSourceText("");
    setMapping({});
  };

  const handleFileChange = async (file: File) => {
    const fileIssue = contactImportTextFileIssue(file);
    if (fileIssue === "invalid_file_type") {
      stellaToast.add({
        title: t("contacts.import.invalidFileType"),
        type: "error",
      });
      return;
    }
    if (fileIssue === "file_too_large") {
      stellaToast.add({
        title: t("contacts.import.fileTooLarge"),
        type: "error",
      });
      return;
    }

    const text = await file.text();
    const parsed = parseContactImportText(text);
    if (parsed.length === 0) {
      stellaToast.add({
        title: t("contacts.import.parseErrorGeneric"),
        type: "error",
      });
      return;
    }
    setResults(null);
    setSourceText(text);
    setMapping({});
    setImportRequestId(toSafeId<"contactImportRequest">(crypto.randomUUID()));
    setRows(assignStableImportIds(parsed));
  };

  const updateMapping = (
    normalizedLabel: string,
    targetField: ParsedImportFieldKey | "ignore",
  ) => {
    const nextMapping = { ...mapping, [normalizedLabel]: targetField };
    setMapping(nextMapping);
    setRows((prev) =>
      applyContactImportMapping({
        rows: prev,
        sourceText,
        mapping: nextMapping,
        normalizedLabel,
        targetField,
      }),
    );
  };

  const updateField = (
    rowIndex: number,
    key: ParsedImportFieldKey,
    value: string,
  ) => {
    setRows((prev) =>
      assignStableImportIds(
        validateRows(
          prev.map((row) =>
            row.rowIndex === rowIndex
              ? { ...row, fields: { ...row.fields, [key]: value } }
              : row,
          ),
        ),
        prev,
      ),
    );
  };

  const removeRow = (rowIndex: number) => {
    setRows((prev) =>
      assignStableImportIds(
        validateRows(prev.filter((row) => row.rowIndex !== rowIndex)),
        prev,
      ),
    );
  };

  const validRows = rows.flatMap((row) => {
    const vars = toImportRowVars(row);
    return vars ? [{ originalRowIndex: row.rowIndex, vars }] : [];
  });
  const validRowVars = validRows.map(({ vars }) => vars);
  const invalidCount = rows.length - validRowVars.length;
  const unrecognizedLabels = [
    ...new Map(
      rows.flatMap((row) =>
        row.blockErrors.flatMap((error) =>
          error.value
            ? [
                [
                  error.normalizedLabel,
                  {
                    label: error.label,
                    normalizedLabel: error.normalizedLabel,
                    sample: error.value,
                  },
                ] as const,
              ]
            : [],
        ),
      ),
    ).values(),
  ];

  const handleConfirm = async () => {
    if (!importRequestId) {
      return;
    }
    try {
      const importResults = await importContacts.mutateAsync({
        importRequestId,
        rows: validRowVars,
      });
      setResults(
        importResults.map((result) => {
          const index =
            validRows.at(result.index)?.originalRowIndex ?? result.index;
          if (result.status === "created") {
            return {
              index,
              status: result.status,
              contactId: result.contactId,
            };
          }
          return { index, status: result.status, reason: result.reason };
        }),
      );
      setRows([]);
      await queryClient.invalidateQueries({ queryKey: contactsKeys.all });
    } catch (error) {
      getAnalytics().captureError(error);
      stellaToast.add({
        title: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          reset();
        }
      }}
      open={open}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <UploadIcon />
        {t("contacts.import.action")}
      </DialogTrigger>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("contacts.import.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {results
              ? t("contacts.import.resultsSummary", {
                  created: results.filter((r) => r.status === "created").length,
                  skipped: results.filter((r) => r.status === "skipped").length,
                })
              : t("contacts.import.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          <ImportDialogBody
            fileInputRef={fileInputRef}
            invalidCount={invalidCount}
            onFileChange={(file) =>
              detached(handleFileChange(file), "contact-import.choose-file")
            }
            onFieldChange={updateField}
            onMappingChange={updateMapping}
            onRemoveRow={removeRow}
            results={results}
            rows={rows}
            unrecognizedLabels={unrecognizedLabels}
            validCount={validRowVars.length}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t(results ? "common.close" : "common.cancel")}
          </DialogClose>
          {!results && rows.length > 0 && (
            <Button
              disabled={validRowVars.length === 0 || !importRequestId}
              loading={importContacts.isPending}
              onClick={() =>
                detached(handleConfirm(), "contact-import.confirm")
              }
              type="button"
            >
              {t("contacts.import.confirmAction")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type ImportDialogBodyProps = {
  results: ImportContactResult[] | null;
  rows: ParsedImportRow[];
  validCount: number;
  invalidCount: number;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileChange: (file: File) => void;
  onFieldChange: (
    rowIndex: number,
    key: ParsedImportFieldKey,
    value: string,
  ) => void;
  onMappingChange: (
    normalizedLabel: string,
    targetField: ParsedImportFieldKey | "ignore",
  ) => void;
  onRemoveRow: (rowIndex: number) => void;
  unrecognizedLabels: UnrecognizedImportLabel[];
};

const ImportDialogBody = ({
  results,
  rows,
  validCount,
  invalidCount,
  fileInputRef,
  onFileChange,
  onFieldChange,
  onMappingChange,
  onRemoveRow,
  unrecognizedLabels,
}: ImportDialogBodyProps) => {
  const t = useTranslations();

  if (results) {
    return <ImportResultsList results={results} />;
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button
          onClick={() => fileInputRef.current?.click()}
          size="sm"
          type="button"
          variant="outline"
        >
          <UploadIcon className="size-3.5" />
          {t("contacts.import.chooseFile")}
        </Button>
        <span className="text-muted-foreground text-xs">
          {t("contacts.import.fileHint")}
        </span>
        <input
          accept=".txt,text/plain"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) {
              return;
            }
            onFileChange(file);
            event.target.value = "";
          }}
          ref={fileInputRef}
          type="file"
        />
      </div>
    );
  }

  return (
    <>
      {unrecognizedLabels.length > 0 && (
        <ImportLabelMapping
          labels={unrecognizedLabels}
          onMappingChange={onMappingChange}
        />
      )}
      <p className="text-muted-foreground text-xs">
        {t("contacts.import.previewSummary", {
          valid: validCount,
          invalid: invalidCount,
        })}
      </p>
      {rows.map((row) => (
        <ImportRowCard
          key={row.rowIndex}
          onFieldChange={(key, value) =>
            onFieldChange(row.rowIndex, key, value)
          }
          onRemove={() => onRemoveRow(row.rowIndex)}
          row={row}
        />
      ))}
    </>
  );
};

const ImportLabelMapping = ({
  labels,
  onMappingChange,
}: {
  labels: UnrecognizedImportLabel[];
  onMappingChange: (
    normalizedLabel: string,
    targetField: ParsedImportFieldKey | "ignore",
  ) => void;
}) => {
  const t = useTranslations();

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3">
      <div>
        <h3 className="text-sm font-medium">
          {t("contacts.import.mappingTitle")}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("contacts.import.mappingDescription")}
        </p>
      </div>
      {labels.map(({ label, normalizedLabel, sample }) => (
        <div
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3"
          key={normalizedLabel}
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{label}</p>
            <p className="text-muted-foreground truncate text-xs">{sample}</p>
          </div>
          <Select
            onValueChange={(value) => {
              if (value === "ignore") {
                onMappingChange(normalizedLabel, value);
                return;
              }
              const target = FIELD_CONFIG.find(({ key }) => key === value);
              if (target) {
                onMappingChange(normalizedLabel, target.key);
              }
            }}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={t("contacts.import.mappingPlaceholder")}
              />
            </SelectTrigger>
            <SelectPopup>
              {FIELD_CONFIG.map(({ key, labelKey }) => (
                <SelectItem key={key} value={key}>
                  {t(labelKey)}
                </SelectItem>
              ))}
              <SelectItem value="ignore">
                {t("contacts.import.mappingIgnore")}
              </SelectItem>
            </SelectPopup>
          </Select>
        </div>
      ))}
    </section>
  );
};

export const RowStatusIcon = ({
  status,
}: {
  status: ParsedImportRow["status"];
}) => {
  if (status === "error") {
    return <AlertTriangleIcon className="text-destructive-foreground size-4" />;
  }
  if (status === "warning") {
    return <AlertTriangleIcon className="text-warning size-4" />;
  }
  return <CheckIcon className="text-success size-4" />;
};

export type ImportRowCardProps = {
  row: ParsedImportRow;
  onFieldChange: (key: ParsedImportFieldKey, value: string) => void;
  onRemove: () => void;
};

export const ImportRowCard = ({
  row,
  onFieldChange,
  onRemove,
}: ImportRowCardProps) => {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <RowStatusIcon status={row.status} />
          {t("contacts.import.rowLabel", { index: String(row.rowIndex + 1) })}
        </span>
        <Button
          aria-label={t("common.remove")}
          onClick={onRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      {row.blockErrors.length > 0 && (
        <ul className="text-destructive-foreground list-inside list-disc text-xs">
          {row.blockErrors.map((error) => (
            <li key={`${row.rowIndex}-${error.label}`}>
              {t("contacts.import.errors.unrecognizedLabel", {
                label: error.label,
              })}
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-3">
        {FIELD_CONFIG.map(({ key, labelKey }) => {
          const error = row.fieldErrors[key];
          return (
            <Field key={key}>
              <FieldLabel>{t(labelKey)}</FieldLabel>
              <Input
                onChange={(event) => onFieldChange(key, event.target.value)}
                value={row.fields[key]}
              />
              {error && (
                <p className="text-destructive-foreground text-xs">
                  {error.code === "duplicateTaxIdInFile"
                    ? t("contacts.import.errors.duplicateTaxIdInFile", {
                        line: String(error.firstRowIndex + 1),
                      })
                    : t(FIELD_ERROR_MESSAGE_KEY[error.code])}
                </p>
              )}
            </Field>
          );
        })}
      </div>
    </div>
  );
};

export const ImportResultsList = ({
  results,
}: {
  results: ImportContactResult[];
}) => {
  const t = useTranslations();

  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {results.map((result) => (
        <li className="flex items-center gap-1.5" key={result.index}>
          {result.status === "created" ? (
            <>
              <CheckIcon className="text-success size-4" />
              {t("contacts.import.rowLabel", {
                index: String(result.index + 1),
              })}
            </>
          ) : (
            <>
              <AlertTriangleIcon className="text-destructive-foreground size-4" />
              {t("contacts.import.rowLabel", {
                index: String(result.index + 1),
              })}
              {" — "}
              {t(SKIP_REASON_MESSAGE_KEY[result.reason])}
            </>
          )}
        </li>
      ))}
    </ul>
  );
};
