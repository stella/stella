import { useRef, useState } from "react";

import { getRouteApi, Link } from "@tanstack/react-router";
import { Result } from "better-result";
import { AlertTriangleIcon, CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import {
  CONTACT_IMPORT_ISSUE_CODE,
  CONTACT_TYPES,
  type ContactImportField,
  type ContactImportIssueCode,
  type ContactImportTaxIdScheme,
  type ContactType,
} from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { Field, FieldLabel } from "@stll/ui/field";
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
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";
import {
  clearContactImportRequest,
  resolveContactImportRequest,
} from "@/routes/_protected.contacts/-contact-import-request";
import {
  customFieldId,
  readCandidateField,
  readCustomFields,
  toWireCandidate,
  withCandidateType,
  withCustomFields,
  writeCandidateField,
} from "@/routes/_protected.contacts/-import-candidate";
import type {
  ImportCandidate,
  ImportCommitPayload,
  ImportEditableField,
  ImportEditableTextField,
  ImportIssue,
  ImportSkipReason,
} from "@/routes/_protected.contacts/-import-candidate";

const VALIDATION_DEBOUNCE_MS = 400;

const protectedRouteApi = getRouteApi("/_protected");

/** One label per import field, shared by the mapping select and the cards. */
export const IMPORT_FIELD_LABELS = {
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

const IMPORT_ISSUE_LABELS = {
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
  [CONTACT_IMPORT_ISSUE_CODE.INVALID_TAX_ID]:
    "contacts.importStudio.issue.invalid_tax_id",
  [CONTACT_IMPORT_ISSUE_CODE.INVALID_TYPE]:
    "contacts.importStudio.issue.invalid_type",
  [CONTACT_IMPORT_ISSUE_CODE.ROW_LENGTH_MISMATCH]:
    "contacts.importStudio.issue.row_length_mismatch",
  [CONTACT_IMPORT_ISSUE_CODE.TAX_ID_REQUIRED]:
    "contacts.importStudio.issue.tax_id_required",
  [CONTACT_IMPORT_ISSUE_CODE.TOO_LONG]: "contacts.importStudio.issue.too_long",
  [CONTACT_IMPORT_ISSUE_CODE.TOO_MANY_CUSTOM_FIELDS]:
    "contacts.importStudio.issue.too_many_custom_fields",
  [CONTACT_IMPORT_ISSUE_CODE.TOO_MANY_TAGS]:
    "contacts.importStudio.issue.too_many_tags",
} as const satisfies Record<ContactImportIssueCode, TranslationKey>;

const IMPORT_SKIP_REASON_LABELS = {
  duplicate_contact_id: "contacts.import.skippedDuplicateContactId",
  duplicate_tax_id: "contacts.import.skippedDuplicateTaxId",
  invalid_row: "contacts.import.skippedInvalidRow",
  invalid_tax_id: "contacts.import.skippedInvalidTaxId",
  contacts_limit_reached: "contacts.import.skippedLimitReached",
} as const satisfies Record<ImportSkipReason, TranslationKey>;

/** Which text fields get a multi-line input. Total, so a new one must decide. */
const IS_MULTILINE_IMPORT_FIELD = {
  address_line_1: false,
  display_name: false,
  first_name: false,
  last_name: false,
  notes: true,
  organization_name: false,
  primary_email: false,
  primary_phone: false,
  registration_number: false,
  tax_id: false,
} as const satisfies Record<ImportEditableTextField, boolean>;

export type ImportReviewSeedRow = {
  candidate: ImportCandidate;
  issues: ImportIssue[];
  /** Position in the source, kept stable while rows are edited or removed. */
  rowNumber: number;
};

export type ImportReviewRow = ImportReviewSeedRow & {
  /** The contact id the commit will use; stable so a retry replays. */
  id: SafeId<"contact">;
};

export type ImportReviewResult = { rowNumber: number; displayName: string } & (
  | { status: "created"; contactId: SafeId<"contact"> }
  | { status: "skipped"; reason: ImportSkipReason }
);

/**
 * Whether the issue list on screen reflects the rows on screen. The server is
 * the only validator, so a rejected validation leaves nothing committable
 * rather than a stale "ready" verdict.
 */
type ImportReviewValidation =
  | { status: "settled" }
  | { status: "pending" }
  | { status: "failed"; message: string };

type UseImportReviewOptions = {
  /** Runs after a successful commit, before the receipt is shown. */
  onImported?: (() => Promise<void>) | undefined;
};

type SeedValidatedArgs = {
  candidates: ImportCandidate[];
  taxIdScheme: ContactImportTaxIdScheme;
};

type SeedArgs = {
  rows: ImportReviewSeedRow[];
  taxIdScheme: ContactImportTaxIdScheme;
};

export type ImportReview = {
  rows: ImportReviewRow[];
  results: ImportReviewResult[] | null;
  validation: ImportReviewValidation;
  validCount: number;
  errorCount: number;
  isImporting: boolean;
  isSeeding: boolean;
  canImport: boolean;
  seed: (args: SeedArgs) => void;
  seedValidated: (args: SeedValidatedArgs) => Promise<boolean>;
  updateRow: (id: SafeId<"contact">, candidate: ImportCandidate) => void;
  removeRow: (id: SafeId<"contact">) => void;
  commit: () => Promise<void>;
  reset: () => void;
};

/**
 * Editable review over reviewed contacts: it holds the rows, asks the server
 * to re-check them after every edit, and commits the ones with no issues under
 * a retry identity keyed on the rows themselves.
 */
export const useImportReview = ({
  onImported,
}: UseImportReviewOptions = {}): ImportReview => {
  const t = useTranslations();
  const scope = protectedRouteApi.useRouteContext({
    select: ({ user }) => ({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }),
  });

  const [rows, setRows] = useState<ImportReviewRow[]>([]);
  const [taxIdScheme, setTaxIdScheme] =
    useState<ContactImportTaxIdScheme>("none");
  const [results, setResults] = useState<ImportReviewResult[] | null>(null);
  const [validation, setValidation] = useState<ImportReviewValidation>({
    status: "settled",
  });
  const [isImporting, setIsImporting] = useState(false);
  const [isSeeding, setIsSeeding] = useState(false);
  // Edits outpace the network: only the newest validation may write issues
  // back, otherwise a slow answer would repaint issues for rows that moved.
  const validationGeneration = useRef(0);

  const requestValidation = async (
    candidates: ImportCandidate[],
    scheme: ContactImportTaxIdScheme,
  ) =>
    await Result.tryPromise(async () => {
      const response = await api.contacts.import.validate.post({
        taxIdScheme: scheme,
        rows: candidates.map(toWireCandidate),
      });
      return unwrapEden(response);
    });

  const revalidate = async () => {
    const generation = validationGeneration.current;
    const pending = rows;
    setValidation({ status: "pending" });
    const result = await requestValidation(
      pending.map(({ candidate }) => candidate),
      taxIdScheme,
    );
    if (generation !== validationGeneration.current) {
      return;
    }
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      setValidation({
        status: "failed",
        message: userErrorFromThrown(
          result.error,
          t("contacts.importStudio.validateFailed"),
        ),
      });
      return;
    }
    setValidation({ status: "settled" });
    setRows((previous) =>
      previous.map((row, index) => {
        const validated = result.value.rows.at(index);
        return validated ? { ...row, issues: validated.issues } : row;
      }),
    );
  };

  const scheduleValidation = useDebouncedCallback(() => {
    detached(revalidate(), "contact-import-review.validate");
  }, VALIDATION_DEBOUNCE_MS);

  const seed = ({ rows: seedRows, taxIdScheme: scheme }: SeedArgs) => {
    validationGeneration.current += 1;
    scheduleValidation.cancel();
    setTaxIdScheme(scheme);
    setResults(null);
    setValidation({ status: "settled" });
    setRows(
      seedRows.map((row) => ({
        ...row,
        id: toSafeId<"contact">(crypto.randomUUID()),
      })),
    );
  };

  const seedValidated = async ({
    candidates,
    taxIdScheme: scheme,
  }: SeedValidatedArgs) => {
    setIsSeeding(true);
    const result = await requestValidation(candidates, scheme);
    setIsSeeding(false);
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({
        title: userErrorFromThrown(
          result.error,
          t("contacts.importStudio.validateFailed"),
        ),
        type: "error",
      });
      return false;
    }
    seed({
      taxIdScheme: scheme,
      rows: result.value.rows.map(({ contact, issues, rowNumber }) => ({
        candidate: contact,
        issues,
        rowNumber,
      })),
    });
    return true;
  };

  const updateRow = (id: SafeId<"contact">, candidate: ImportCandidate) => {
    validationGeneration.current += 1;
    // An unchecked edit is not committable, so the verdict goes stale the
    // moment the reviewer types, not when the debounced request starts.
    setValidation({ status: "pending" });
    setRows((previous) =>
      previous.map((row) => (row.id === id ? { ...row, candidate } : row)),
    );
    scheduleValidation();
  };

  const removeRow = (id: SafeId<"contact">) => {
    validationGeneration.current += 1;
    scheduleValidation.cancel();
    setValidation({ status: "settled" });
    setRows((previous) => previous.filter((row) => row.id !== id));
  };

  const reset = () => {
    validationGeneration.current += 1;
    scheduleValidation.cancel();
    setRows([]);
    setResults(null);
    setValidation({ status: "settled" });
  };

  const validRows = rows.filter(({ issues }) => issues.length === 0);
  const errorCount = rows.length - validRows.length;
  const canImport =
    validRows.length > 0 && validation.status === "settled" && !isImporting;

  const commit = async () => {
    if (!canImport) {
      return;
    }
    setIsImporting(true);
    const payload = {
      taxIdScheme,
      rows: validRows.map(({ candidate, id }) => ({
        id,
        ...toWireCandidate(candidate),
      })),
    } satisfies ImportCommitPayload;

    const outcome = await Result.tryPromise(async () => {
      const request = await resolveContactImportRequest({ payload, scope });
      const response = await api.contacts.import.put({
        importRequestId: request.id,
        ...payload,
      });
      return { data: unwrapEden(response), request };
    });
    setIsImporting(false);

    if (Result.isError(outcome)) {
      getAnalytics().captureError(outcome.error);
      stellaToast.add({
        title: userErrorFromThrown(
          outcome.error,
          t("contacts.importStudio.importFailed"),
        ),
        type: "error",
      });
      return;
    }

    clearContactImportRequest({ storageKey: outcome.value.request.storageKey });
    setResults(
      outcome.value.data.results.map((result) => {
        const row = validRows.at(result.index);
        const rowNumber = row?.rowNumber ?? result.index;
        const displayName = row?.candidate.displayName ?? "";
        return result.status === "created"
          ? {
              rowNumber,
              displayName,
              status: "created",
              contactId: result.contactId,
            }
          : {
              rowNumber,
              displayName,
              status: "skipped",
              reason: result.reason,
            };
      }),
    );
    setRows([]);
    await onImported?.();
  };

  return {
    rows,
    results,
    validation,
    validCount: validRows.length,
    errorCount,
    isImporting,
    isSeeding,
    canImport,
    seed,
    seedValidated,
    updateRow,
    removeRow,
    commit,
    reset,
  };
};

type ImportCandidateCardProps = {
  row: ImportReviewRow;
  /** Which inputs the card offers, in the order they are shown. */
  fields: readonly ImportEditableField[];
  onChange: (candidate: ImportCandidate) => void;
  onRemove: () => void;
  /** 1-based position in the review list; the title falls back to it. */
  ordinal: number;
};

/** One reviewed contact, editable, with the issues the server reported on it. */
export const ImportCandidateCard = ({
  row,
  fields,
  onChange,
  onRemove,
  ordinal,
}: ImportCandidateCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const customFields = readCustomFields(row.candidate);

  const setCustomField = (
    index: number,
    patch: { label?: string; value?: string },
  ) => {
    onChange(
      withCustomFields(
        row.candidate,
        customFields.map((field, fieldIndex) => {
          if (fieldIndex !== index) {
            return field;
          }
          const label = patch.label ?? field.label;
          return {
            id: customFieldId(label, fieldIndex),
            label,
            value: patch.value ?? field.value,
          };
        }),
      ),
    );
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          {row.issues.length === 0 ? (
            <CheckIcon className="text-success size-4" />
          ) : (
            <AlertTriangleIcon className="text-destructive size-4" />
          )}
          <span>
            {row.candidate.displayName.trim() ||
              t("contacts.import.rowLabel", {
                index: format.number(ordinal),
              })}
          </span>
          <span className="text-muted-foreground font-normal">
            {t("contacts.importStudio.sourceRow", {
              index: format.number(row.rowNumber),
            })}
          </span>
        </h3>
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

      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) =>
          field === "type" ? (
            <Field key={field}>
              <FieldLabel>{t(IMPORT_FIELD_LABELS.type)}</FieldLabel>
              <Select
                onValueChange={(value) => {
                  if (isContactType(value)) {
                    onChange(withCandidateType(row.candidate, value));
                  }
                }}
                value={row.candidate.type}
              >
                <SelectTrigger>
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
            </Field>
          ) : (
            <Field
              className={cn(
                IS_MULTILINE_IMPORT_FIELD[field] && "sm:col-span-2",
              )}
              key={field}
            >
              <FieldLabel>{t(IMPORT_FIELD_LABELS[field])}</FieldLabel>
              {IS_MULTILINE_IMPORT_FIELD[field] ? (
                <Textarea
                  onChange={(event) =>
                    onChange(
                      writeCandidateField(
                        row.candidate,
                        field,
                        event.target.value,
                      ),
                    )
                  }
                  rows={3}
                  value={readCandidateField(row.candidate, field)}
                />
              ) : (
                <Input
                  onChange={(event) =>
                    onChange(
                      writeCandidateField(
                        row.candidate,
                        field,
                        event.target.value,
                      ),
                    )
                  }
                  value={readCandidateField(row.candidate, field)}
                />
              )}
            </Field>
          ),
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-muted-foreground text-xs font-medium">
          {t("contacts.customFields.title")}
        </legend>
        {customFields.map((field, index) => (
          <div
            className="flex items-end gap-2"
            key={`custom-field-${String(index)}`}
          >
            <Field className="min-w-0 flex-1">
              <FieldLabel className="sr-only">
                {t("contacts.customFields.label")}
              </FieldLabel>
              <Input
                aria-label={t("contacts.customFields.label")}
                onChange={(event) =>
                  setCustomField(index, { label: event.target.value })
                }
                placeholder={t("contacts.customFields.labelPlaceholder")}
                value={field.label}
              />
            </Field>
            <Field className="min-w-0 flex-1">
              <FieldLabel className="sr-only">
                {t("contacts.customFields.value")}
              </FieldLabel>
              <Input
                aria-label={t("contacts.customFields.value")}
                onChange={(event) =>
                  setCustomField(index, { value: event.target.value })
                }
                placeholder={t("common.value")}
                value={field.value}
              />
            </Field>
            <Button
              aria-label={t("contacts.customFields.removeField")}
              onClick={() =>
                onChange(
                  withCustomFields(
                    row.candidate,
                    customFields.filter(
                      (_, fieldIndex) => fieldIndex !== index,
                    ),
                  ),
                )
              }
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </div>
        ))}
        <Button
          className="self-start"
          onClick={() =>
            onChange(
              withCustomFields(row.candidate, [
                ...customFields,
                {
                  id: customFieldId("", customFields.length),
                  label: "",
                  value: "",
                },
              ]),
            )
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          <PlusIcon />
          {t("contacts.customFields.addField")}
        </Button>
      </fieldset>

      {row.issues.length > 0 && (
        <ul className="text-destructive space-y-1 text-xs">
          {row.issues.map((issue) => (
            <li
              className="flex items-start gap-1.5"
              key={`${issue.code}-${issue.field ?? "row"}`}
            >
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {t(IMPORT_ISSUE_LABELS[issue.code])}
                {issue.field && (
                  <span className="text-muted-foreground ms-1">
                    ({t(IMPORT_FIELD_LABELS[issue.field])})
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** The receipt a commit returns: one line per submitted row. */
export const ImportResultsList = ({
  results,
}: {
  results: ImportReviewResult[];
}) => {
  const t = useTranslations();
  const format = useFormatter();

  // Each line names the contact; a created one links to its page so the
  // receipt is a way into the imported data, not just a tally.
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {results.map((result) => (
        <li className="flex items-center gap-1.5" key={result.rowNumber}>
          {result.status === "created" ? (
            <>
              <CheckIcon className="text-success size-4 shrink-0" />
              <Link
                className="hover:underline"
                params={{ contactId: result.contactId }}
                to="/contacts/$contactId"
              >
                {result.displayName ||
                  t("contacts.import.rowLabel", {
                    index: format.number(result.rowNumber),
                  })}
              </Link>
            </>
          ) : (
            <>
              <AlertTriangleIcon className="text-destructive size-4 shrink-0" />
              <span>
                {result.displayName ||
                  t("contacts.import.rowLabel", {
                    index: format.number(result.rowNumber),
                  })}
              </span>
              <span className="text-muted-foreground">
                {t(IMPORT_SKIP_REASON_LABELS[result.reason])}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
};

const isContactType = (value: unknown): value is ContactType =>
  CONTACT_TYPES.some((type) => type === value);
