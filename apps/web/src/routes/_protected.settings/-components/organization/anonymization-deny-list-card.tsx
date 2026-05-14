import { useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Trash2, UploadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { DEFAULT_CHAT_ANON_ENTITY_LABELS } from "@stll/anonymize-chat";
import { Button } from "@stll/ui/components/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import type { OrgAnonymizationBlacklistEntry } from "@/routes/_protected.settings/-mutations/anonymization-blacklist";
import { useUpdateOrganizationAnonymizationBlacklist } from "@/routes/_protected.settings/-mutations/anonymization-blacklist";
import { organizationAnonymizationBlacklistOptions } from "@/routes/_protected.settings/-queries/anonymization-blacklist";

// Entity labels come from the pipeline package so the firm-wide
// catalog never drifts out of sync with the recogniser's known
// kinds. The wasm matcher keys gazetteer hits on canonical text
// only — the label is metadata for grouping/display — so we
// prepend a generic "miscellaneous" bucket that paste-in lists
// can land in without forcing the user to pick a category they
// don't care about.
const MISCELLANEOUS_LABEL = "miscellaneous" as const;
const LABEL_OPTIONS = [
  MISCELLANEOUS_LABEL,
  ...DEFAULT_CHAT_ANON_ENTITY_LABELS,
] as const;

type LabelOption = (typeof LABEL_OPTIONS)[number];

const DEFAULT_LABEL: LabelOption = MISCELLANEOUS_LABEL;

// Saved values stay in their canonical English form (the
// pipeline matches by string equality); the dropdown + sublabel
// render via i18n. `as const satisfies` keeps the literal key
// types so the typed `t()` accepts a single argument and the
// `satisfies TranslationKey` check fails the build if a key
// goes stale.
const LABEL_TRANSLATION_KEY = {
  miscellaneous: "common.anonymizationLabels.miscellaneous",
  person: "common.anonymizationLabels.person",
  organization: "common.anonymizationLabels.organization",
  "phone number": "common.anonymizationLabels.phoneNumber",
  address: "common.anonymizationLabels.address",
  "email address": "common.anonymizationLabels.emailAddress",
  date: "common.anonymizationLabels.date",
  "date of birth": "common.anonymizationLabels.dateOfBirth",
  "bank account number": "common.anonymizationLabels.bankAccountNumber",
  iban: "common.anonymizationLabels.iban",
  "tax identification number":
    "common.anonymizationLabels.taxIdentificationNumber",
  "identity card number": "common.anonymizationLabels.identityCardNumber",
  "registration number": "common.anonymizationLabels.registrationNumber",
  "credit card number": "common.anonymizationLabels.creditCardNumber",
  "passport number": "common.anonymizationLabels.passportNumber",
  "monetary amount": "common.anonymizationLabels.monetaryAmount",
  "land parcel": "common.anonymizationLabels.landParcel",
} as const satisfies Record<LabelOption, TranslationKey>;

const isKnownLabel = (label: string): label is LabelOption =>
  (LABEL_OPTIONS as readonly string[]).includes(label);

/**
 * Best-effort parse of an uploaded deny list. Supports:
 *   - JSON: an array of strings (canonicals only, default label
 *     applied) or an array of `{ canonical, label?, variants? }`.
 *   - CSV: header optional; columns `canonical, label, variants`
 *     where variants are `|`-separated within a single cell.
 *   - TXT / fallback: one canonical per line.
 *
 * Returns `null` when nothing usable was found so the caller can
 * surface a single "couldn't parse the file" toast instead of
 * silently inserting empty rows.
 */
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

const readField = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
};

const parseJsonItem = (
  item: unknown,
  defaultLabel: LabelOption,
): OrgAnonymizationBlacklistEntry | null => {
  if (typeof item === "string") {
    const canonical = item.trim();
    return canonical.length > 0 ? { canonical, label: defaultLabel } : null;
  }
  const rawCanonical = readField(item, "canonical");
  const canonical = typeof rawCanonical === "string" ? rawCanonical.trim() : "";
  if (canonical.length === 0) {
    return null;
  }
  const rawLabel = readField(item, "label");
  const label =
    typeof rawLabel === "string" && rawLabel.trim().length > 0
      ? rawLabel.trim()
      : defaultLabel;
  const rawVariants = readField(item, "variants");
  const variants = isStringArray(rawVariants)
    ? rawVariants.map((v) => v.trim()).filter((v) => v.length > 0)
    : undefined;
  return {
    canonical,
    label,
    ...(variants && variants.length > 0 ? { variants } : {}),
  };
};

const parseJson = (
  trimmed: string,
  defaultLabel: LabelOption,
): OrgAnonymizationBlacklistEntry[] | null => {
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const rows: OrgAnonymizationBlacklistEntry[] = [];
    for (const item of parsed) {
      const entry = parseJsonItem(item, defaultLabel);
      if (entry) {
        rows.push(entry);
      }
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
};

const parseCsvLine = (
  line: string,
  defaultLabel: LabelOption,
): OrgAnonymizationBlacklistEntry | null => {
  // Naive split — quoted CSV values aren't expected for PII
  // canonicals, so the unquoted parser keeps the import short
  // and predictable. Variants column uses `|` as inner
  // separator to avoid colliding with the CSV delimiter.
  const cells = line.split(/[,;]/).map((cell) => cell.trim());
  const canonical = cells[0] ?? "";
  if (canonical.length === 0) {
    return null;
  }
  const cellLabel = cells[1];
  const label = cellLabel && cellLabel.length > 0 ? cellLabel : defaultLabel;
  const variantsCell = cells[2];
  const variants = variantsCell
    ? variantsCell
        .split("|")
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    : undefined;
  return {
    canonical,
    label,
    ...(variants && variants.length > 0 ? { variants } : {}),
  };
};

const parseImport = (
  text: string,
  fileName: string,
  defaultLabel: LabelOption,
): OrgAnonymizationBlacklistEntry[] | null => {
  const lower = fileName.toLowerCase();
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (lower.endsWith(".json") || trimmed.startsWith("[")) {
    return parseJson(trimmed, defaultLabel);
  }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  const first = lines[0] ?? "";
  const isCsv =
    lower.endsWith(".csv") || first.includes(",") || first.includes(";");
  if (!isCsv) {
    return lines
      .map((line) => ({ canonical: line.trim(), label: defaultLabel }))
      .filter((entry) => entry.canonical.length > 0);
  }

  // CSV: drop an optional header row (`canonical,...`).
  const headerLooksLikeHeader =
    first.toLowerCase().split(/[,;]/).at(0)?.trim() === "canonical";
  const dataLines = headerLooksLikeHeader ? lines.slice(1) : lines;
  const rows: OrgAnonymizationBlacklistEntry[] = [];
  for (const line of dataLines) {
    const entry = parseCsvLine(line, defaultLabel);
    if (entry) {
      rows.push(entry);
    }
  }
  return rows.length > 0 ? rows : null;
};

const dedupeByCanonical = (
  entries: readonly OrgAnonymizationBlacklistEntry[],
): OrgAnonymizationBlacklistEntry[] => {
  const seen = new Map<string, OrgAnonymizationBlacklistEntry>();
  for (const entry of entries) {
    const key = entry.canonical.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }
  return [...seen.values()];
};

export const AnonymizationDenyListCard = () => {
  const t = useTranslations();
  const blacklistQuery = useQuery(organizationAnonymizationBlacklistOptions);
  const updateMutation = useUpdateOrganizationAnonymizationBlacklist();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [pendingCanonical, setPendingCanonical] = useState("");
  const [pendingLabel, setPendingLabel] = useState<LabelOption>(DEFAULT_LABEL);

  const entries = blacklistQuery.data?.entries ?? [];

  const submitTerm = () => {
    const canonical = pendingCanonical.trim();
    if (canonical.length === 0) {
      return;
    }
    const next = dedupeByCanonical([
      ...entries.map((entry) => ({
        canonical: entry.canonical,
        label: entry.label,
        variants: entry.variants,
        enabled: entry.enabled,
      })),
      { canonical, label: pendingLabel },
    ]);
    updateMutation.mutate(
      { entries: next },
      {
        onSuccess: () => {
          setPendingCanonical("");
          setPendingLabel(DEFAULT_LABEL);
          stellaToast.add({
            title: t("settings.organization.anonymization.termAddedToast", {
              value: canonical,
            }),
            type: "success",
          });
        },
        onError: (error) => {
          stellaToast.add({
            title: error instanceof Error ? error.message : String(error),
            type: "error",
          });
        },
      },
    );
  };

  const removeEntry = (canonical: string) => {
    const next = entries
      .filter((entry) => entry.canonical !== canonical)
      .map((entry) => ({
        canonical: entry.canonical,
        label: entry.label,
        variants: entry.variants,
        enabled: entry.enabled,
      }));
    updateMutation.mutate(
      { entries: next },
      {
        onError: (error) => {
          stellaToast.add({
            title: error instanceof Error ? error.message : String(error),
            type: "error",
          });
        },
      },
    );
  };

  const handleImportFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseImport(text, file.name, pendingLabel);
    if (!parsed || parsed.length === 0) {
      stellaToast.add({
        title: t("settings.organization.anonymization.importParseError"),
        type: "error",
      });
      return;
    }
    const merged = dedupeByCanonical([
      ...entries.map((entry) => ({
        canonical: entry.canonical,
        label: entry.label,
        variants: entry.variants,
        enabled: entry.enabled,
      })),
      ...parsed,
    ]);
    updateMutation.mutate(
      { entries: merged },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("settings.organization.anonymization.importSuccessToast", {
              count: String(parsed.length),
            }),
            type: "success",
          });
        },
        onError: (error) => {
          stellaToast.add({
            title: error instanceof Error ? error.message : String(error),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <form
            className="flex flex-col gap-2 rounded-md border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitTerm();
            }}
          >
            <Input
              autoComplete="off"
              disabled={updateMutation.isPending}
              onChange={(event) => setPendingCanonical(event.target.value)}
              placeholder={t(
                "settings.organization.anonymization.addPlaceholder",
              )}
              value={pendingCanonical}
            />
            <div className="flex items-center gap-2">
              <Combobox<LabelOption>
                autoHighlight
                disabled={updateMutation.isPending}
                items={[...LABEL_OPTIONS]}
                itemToStringLabel={(option) => t(LABEL_TRANSLATION_KEY[option])}
                onValueChange={(next) => {
                  if (next) {
                    setPendingLabel(next);
                  }
                }}
                value={pendingLabel}
              >
                <ComboboxInput
                  aria-label={t(
                    "settings.organization.anonymization.labelPickerAriaLabel",
                  )}
                  className="h-9 min-w-0 flex-1 text-xs"
                  placeholder={t(
                    "settings.organization.anonymization.labelPickerPlaceholder",
                  )}
                />
                <ComboboxPopup>
                  <ComboboxList>
                    {(option: LabelOption) => (
                      <ComboboxItem key={option} value={option}>
                        {t(LABEL_TRANSLATION_KEY[option])}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                  <ComboboxEmpty>
                    {t("settings.organization.anonymization.labelPickerEmpty")}
                  </ComboboxEmpty>
                </ComboboxPopup>
              </Combobox>
              <Button
                disabled={
                  pendingCanonical.trim().length === 0 ||
                  updateMutation.isPending
                }
                size="sm"
                type="submit"
              >
                {t("settings.organization.anonymization.addAction")}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => fileInputRef.current?.click()}
                size="sm"
                type="button"
                variant="outline"
              >
                <UploadIcon className="size-3.5" />
                {t("settings.organization.anonymization.importAction")}
              </Button>
              <span className="text-muted-foreground text-xs">
                {t("settings.organization.anonymization.importHint")}
              </span>
              <input
                accept=".csv,.txt,.json,text/csv,text/plain,application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) {
                    return;
                  }
                  void handleImportFile(file);
                  event.target.value = "";
                }}
                ref={fileInputRef}
                type="file"
              />
            </div>
          </form>

          <div className="flex flex-col gap-1">
            <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("settings.organization.anonymization.entriesHeading", {
                count: String(entries.length),
              })}
            </div>
            {blacklistQuery.isLoading && (
              <div className="text-muted-foreground py-6 text-center text-xs">
                {t("common.loading")}
              </div>
            )}
            {!blacklistQuery.isLoading && entries.length === 0 && (
              <div className="text-muted-foreground rounded-md border border-dashed py-6 text-center text-xs">
                {t("settings.organization.anonymization.emptyState")}
              </div>
            )}
            {entries.map((entry) => (
              <div
                className="hover:bg-muted/50 flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                key={entry.id}
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">
                    {entry.canonical}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {isKnownLabel(entry.label)
                      ? t(LABEL_TRANSLATION_KEY[entry.label])
                      : entry.label}
                  </span>
                </div>
                <Button
                  disabled={updateMutation.isPending}
                  onClick={() => removeEntry(entry.canonical)}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">
                    {t("settings.organization.anonymization.deleteAction")}
                  </span>
                </Button>
              </div>
            ))}
          </div>
        </div>
      </FramePanel>
    </Frame>
  );
};
