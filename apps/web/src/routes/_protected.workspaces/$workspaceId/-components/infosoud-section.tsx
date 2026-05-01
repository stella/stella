import { useMemo, useState } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import { toastManager } from "@stll/ui/components/toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import {
  CalendarClockIcon,
  CalendarPlusIcon,
  LoaderIcon,
  SearchIcon,
  ScaleIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

type InfoSoudSectionProps = {
  workspaceId: string;
  active: boolean;
};

type CourtOption = {
  code: string;
  name: string;
};

type InfoSoudLookupInput = {
  courtCode: string;
  spisZn: string;
};

type InfoSoudLookupResult = {
  caseMark: string;
  court: string;
  courtCode: string;
  eventCount: number;
  events: {
    cancelled: boolean;
    caseMark: string;
    courtCode: string;
    date: string | null;
    isRelatedCase: boolean;
    label: string;
    order: number;
    type: string;
  }[];
  eventsTruncated: boolean;
  hearings: {
    cancelled: boolean | null;
    date: string | null;
    hearingType: string | null;
    judge: string | null;
    private: boolean | null;
    result: string | null;
    room: string | null;
    scheduledAt: string | null;
    time: string | null;
  }[];
  hearingsTruncated: boolean;
  parentCourt: string | null;
  relatedCases: {
    caseMark: string;
    courtCode: string;
  }[];
  relatedCasesTruncated: boolean;
  status: string | null;
  statusDate: string | null;
  validTo: string | null;
};

export const InfoSoudSection = ({
  active,
  workspaceId,
}: InfoSoudSectionProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const canCreateAgenda = usePermissions({ entity: ["create"] });
  const [courtQuery, setCourtQuery] = useState("");
  const [selectedCourt, setSelectedCourt] = useState<CourtOption | null>(null);
  const [spisZn, setSpisZn] = useState("");
  const [result, setResult] = useState<InfoSoudLookupResult | null>(null);
  const [lastLookupInput, setLastLookupInput] =
    useState<InfoSoudLookupInput | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [importPending, setImportPending] = useState(false);
  const [lookupPending, setLookupPending] = useState(false);

  const courtsQuery = useQuery({
    enabled: active,
    queryKey: [...workspacesKeys.byId(workspaceId), "infosoud", "courts"],
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .infosoud.courts.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.courts;
    },
  });

  const filteredCourts = useMemo(() => {
    const courts = courtsQuery.data ?? [];
    const query = normalizeSearch(courtQuery);
    if (!query) {
      return courts.slice(0, 80);
    }

    return courts
      .filter((court) =>
        normalizeSearch(`${court.name} ${court.code}`).includes(query),
      )
      .slice(0, 80);
  }, [courtQuery, courtsQuery.data]);

  const handleLookup = async () => {
    const trimmedSpisZn = spisZn.trim();
    if (!selectedCourt || !trimmedSpisZn || lookupPending) {
      return;
    }

    setLookupPending(true);
    setLookupError("");
    setLastLookupInput(null);

    const lookupResult = await Result.tryPromise(async () => {
      const response = await api
        .workspaces({ workspaceId })
        .infosoud.lookup.post({
          courtCode: selectedCourt.code,
          spisZn: trimmedSpisZn,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    });

    setLookupPending(false);

    if (Result.isError(lookupResult)) {
      const message = resolveLookupErrorMessage({
        error: lookupResult.error,
        fallback: t("workspaces.infosoud.lookupFailed"),
        notFound: t("workspaces.infosoud.notFound"),
      });
      setLookupError(message);
      toastManager.add({ title: message, type: "error" });
      return;
    }

    setLastLookupInput({
      courtCode: selectedCourt.code,
      spisZn: trimmedSpisZn,
    });
    setResult(lookupResult.value);
  };

  const handleImportAgenda = async () => {
    if (!lastLookupInput || importPending) {
      return;
    }

    setImportPending(true);
    const importResult = await Result.tryPromise(async () => {
      const response = await api
        .workspaces({ workspaceId })
        .infosoud["import-agenda"].post({
          ...lastLookupInput,
          queryKey: entitiesKeys.all(workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    });
    setImportPending(false);

    if (Result.isError(importResult)) {
      const message = resolveLookupErrorMessage({
        error: importResult.error,
        fallback: t("workspaces.infosoud.importAgendaFailed"),
        notFound: t("workspaces.infosoud.notFound"),
      });
      toastManager.add({ title: message, type: "error" });
      return;
    }

    await queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    });

    toastManager.add({
      title:
        importResult.value.created === 0
          ? t("workspaces.infosoud.importAgendaUpToDate")
          : t("workspaces.infosoud.importAgendaResult", {
              count: importResult.value.created,
            }),
      type: "success",
    });
  };

  const courtLoading = courtsQuery.isPending && active;
  const courtError = courtsQuery.isError
    ? t("workspaces.infosoud.courtsFailed")
    : "";
  const canLookup = selectedCourt !== null && spisZn.trim().length > 0;

  return (
    <section className="px-4">
      <div className="mb-3 flex items-center gap-2">
        <ScaleIcon className="text-muted-foreground size-4" />
        <h3 className="text-sm font-medium">
          {t("workspaces.infosoud.title")}
        </h3>
      </div>

      <div className="space-y-3">
        <Field>
          <FieldLabel>{t("workspaces.infosoud.court")}</FieldLabel>
          <Combobox<CourtOption>
            itemToStringLabel={(court) => `${court.name} ${court.code}`}
            onInputValueChange={setCourtQuery}
            onValueChange={(court) => {
              setSelectedCourt(court);
              setLookupError("");
              setLastLookupInput(null);
              setResult(null);
              if (court) {
                setCourtQuery(`${court.name} (${court.code})`);
              }
            }}
            value={selectedCourt}
          >
            <ComboboxInput
              disabled={courtLoading || courtsQuery.isError}
              placeholder={t("workspaces.infosoud.courtPlaceholder")}
              showClear={courtQuery.length > 0}
              startAddon={
                courtLoading ? (
                  <LoaderIcon className="animate-spin" />
                ) : (
                  <SearchIcon />
                )
              }
              value={courtQuery}
            />
            <ComboboxPopup>
              <ComboboxList>
                {filteredCourts.map((court) => (
                  <ComboboxItem key={court.code} value={court}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{court.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {court.code}
                      </span>
                    </div>
                  </ComboboxItem>
                ))}
              </ComboboxList>
              {filteredCourts.length === 0 ? (
                <ComboboxEmpty>{t("common.noResults")}</ComboboxEmpty>
              ) : null}
            </ComboboxPopup>
          </Combobox>
          {courtError ? (
            <p className="text-destructive text-xs">{courtError}</p>
          ) : null}
        </Field>

        <Field>
          <FieldLabel>{t("workspaces.infosoud.spisZn")}</FieldLabel>
          <div className="flex gap-2">
            <Input
              className="min-w-0"
              onChange={(event) => {
                setSpisZn(event.target.value);
                setLookupError("");
                setLastLookupInput(null);
                setResult(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleLookup();
                }
              }}
              placeholder={t("workspaces.infosoud.spisZnPlaceholder")}
              value={spisZn}
            />
            <Button
              disabled={!canLookup || lookupPending}
              onClick={() => {
                void handleLookup();
              }}
            >
              {lookupPending ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                <SearchIcon className="size-4" />
              )}
              {t("workspaces.infosoud.lookup")}
            </Button>
          </div>
          {lookupError ? (
            <p className="text-destructive text-xs">{lookupError}</p>
          ) : null}
        </Field>
      </div>

      {result ? (
        <InfoSoudResult
          canImport={canCreateAgenda && lastLookupInput !== null}
          importPending={importPending}
          onImport={() => {
            void handleImportAgenda();
          }}
          result={result}
        />
      ) : null}
    </section>
  );
};

const InfoSoudResult = ({
  canImport,
  importPending,
  onImport,
  result,
}: {
  canImport: boolean;
  importPending: boolean;
  onImport: () => void;
  result: InfoSoudLookupResult;
}) => {
  const t = useTranslations();
  const visibleEvents = result.events.slice(0, 8);
  const statusLabel = formatInfoSoudValue(result.status);

  return (
    <div className="border-border/70 bg-muted/30 mt-4 rounded-lg border p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{result.caseMark}</p>
          <p className="text-muted-foreground truncate text-xs">
            {result.court}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {statusLabel !== null ? (
            <span className="bg-background rounded-md border px-2 py-1 text-xs">
              {statusLabel}
            </span>
          ) : null}
          {canImport ? (
            <Button
              disabled={importPending}
              onClick={onImport}
              size="xs"
              variant="outline"
            >
              {importPending ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <CalendarPlusIcon className="size-3.5" />
              )}
              {t("workspaces.infosoud.importAgenda")}
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <InfoSoudDefinition
          label={t("workspaces.infosoud.statusDate")}
          value={result.statusDate}
        />
        <InfoSoudDefinition
          label={t("workspaces.infosoud.validTo")}
          value={formatValidTo(result.validTo)}
        />
      </dl>

      <div className="mt-4 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CalendarClockIcon className="text-muted-foreground size-4" />
          {t("workspaces.infosoud.hearings")}
        </div>
        {result.hearings.length > 0 ? (
          <div className="space-y-2">
            {result.hearings.slice(0, 3).map((hearing, hearingIndex) => (
              <div
                className="bg-background/70 rounded-md border px-2 py-1.5 text-xs"
                key={[
                  formatInfoSoudValue(hearing.date),
                  formatInfoSoudValue(hearing.time),
                  hearing.room ?? "",
                  hearing.judge ?? "",
                  hearing.hearingType ?? "",
                  hearingIndex,
                ].join(":")}
              >
                <div className="flex justify-between gap-2">
                  <span className="font-medium">
                    {formatInfoSoudValue(hearing.scheduledAt)}
                  </span>
                  {hearing.cancelled ? (
                    <span className="text-destructive">
                      {t("workspaces.infosoud.cancelled")}
                    </span>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-0.5 truncate">
                  {[hearing.hearingType, hearing.room, hearing.judge]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            {t("workspaces.infosoud.noHearings")}
          </p>
        )}
      </div>

      {visibleEvents.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {t("workspaces.infosoud.events")}
            </p>
            <span className="text-muted-foreground text-xs">
              {t("workspaces.infosoud.eventCount", {
                count: result.eventCount,
              })}
            </span>
          </div>
          <ol className="space-y-2">
            {visibleEvents.map((event) => (
              <li
                className="grid grid-cols-[5.75rem_1fr] gap-2 text-xs"
                key={`${formatInfoSoudValue(event.date)}-${event.order}-${event.type}-${event.caseMark}`}
              >
                <time className="text-muted-foreground">
                  {formatInfoSoudValue(event.date)}
                </time>
                <div className="min-w-0">
                  <p className="truncate">
                    {event.label}
                    {event.cancelled
                      ? ` (${t("workspaces.infosoud.cancelled")})`
                      : ""}
                  </p>
                  {event.isRelatedCase ? (
                    <p className="text-muted-foreground truncate">
                      {event.caseMark}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {result.relatedCases.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium">
            {t("workspaces.infosoud.relatedCases")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {result.relatedCases.map((relatedCase) => (
              <span
                className="bg-background rounded-md border px-2 py-1 text-xs"
                key={relatedCase.caseMark}
              >
                {relatedCase.caseMark}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const InfoSoudDefinition = ({
  label,
  value,
}: {
  label: string;
  value: string | number | boolean | null;
}) => (
  <div className="min-w-0">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="truncate">{formatInfoSoudValue(value) ?? "—"}</dd>
  </div>
);

const normalizeSearch = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase("cs-CZ")
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .replaceAll(/\s+/gu, " ");

const formatValidTo = (value: string | null): string | null => {
  const displayValue = formatInfoSoudValue(value);
  return displayValue === null ? null : displayValue.slice(0, 10);
};

const formatInfoSoudValue = (
  value: string | number | boolean | null,
): string | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return value.toString();
};

const resolveLookupErrorMessage = ({
  error,
  fallback,
  notFound,
}: {
  error: unknown;
  fallback: string;
  notFound: string;
}) => {
  if (APIError.is(error) && error.status === 404) {
    return notFound;
  }

  if (APIError.is(error) && error.status < 500) {
    return error.message;
  }

  return fallback;
};
