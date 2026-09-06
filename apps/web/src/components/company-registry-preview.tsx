import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { getAresCourtName } from "@stll/business-registries/ares";
import type { AresCompany } from "@stll/business-registries/ares";
import { getAresLegalFormName } from "@stll/business-registries/ares/legal-forms";
import { parseIsoDateLocal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@stll/ui/table";

import { registryDetailLabel } from "@/components/company-registry-labels";
import { CompanySpecification } from "@/components/company-specification";
import type { RegistryHit } from "@/components/templates/registry-autofill";
import type { LookupRegistryOption } from "@/components/templates/registry-options";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { businessRegistryQueryOptions } from "@/lib/business-registries/queries";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { CALENDAR_DATE_FORMAT } from "@/lib/relative-time";
import { sanitizeHref } from "@/lib/sanitize-href";

type CompanyRegistryPreviewProps = {
  companyId: string;
  registry: LookupRegistryOption["slug"];
};

/** Full company record shared by global search and registry citations. */
export const CompanyRegistryPreview = ({
  companyId,
  registry,
}: CompanyRegistryPreviewProps) => {
  const t = useTranslations();
  const organizationId = useAuthenticatedUser().activeOrganizationId;
  const { data, error, isPending, refetch } = useQuery(
    businessRegistryQueryOptions({
      organizationId,
      registry,
      query: companyId,
    }),
  );
  const hit: RegistryHit | null =
    data?.type === "lookup"
      ? data.hit
      : (data?.hits.find((candidate) => candidate.id === companyId) ?? null);

  if (isPending) {
    return <CompanyRegistryPreviewSkeleton />;
  }

  if (error) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 p-6">
        <p className="text-muted-foreground text-center text-sm" role="alert">
          {userErrorFromThrown(error, t("common.somethingWentWrong"))}
        </p>
        <Button
          onClick={() => detached(refetch(), "company-registry-preview.retry")}
          size="sm"
          variant="outline"
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (hit === null) {
    return (
      <p className="text-muted-foreground p-6 text-sm">
        {t("common.noResults")}
      </p>
    );
  }

  return (
    <div className="h-full space-y-6 overflow-y-auto overscroll-contain p-5">
      <CompanyIdentity hit={hit} registry={registry} />
      <CompanySpecification companyId={hit.id} registry={registry} />
      {hit.details ? <RegistryDetails details={hit.details} /> : null}
    </div>
  );
};

const CompanyIdentity = ({
  hit,
  registry,
}: {
  hit: RegistryHit;
  registry: LookupRegistryOption["slug"];
}) => {
  const t = useTranslations();
  const sourceUrl = sanitizeHref(hit.registryUrl);
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold text-balance" dir="auto">
            {hit.name}
          </h2>
          <p className="text-muted-foreground font-mono text-xs">
            {t(
              registry === "ares"
                ? "contacts.create.icoPlaceholder"
                : "search.registryDetails.identifier",
            )}
            : <bdi>{hit.id}</bdi>
          </p>
        </div>
        {sourceUrl ? (
          <a
            className="hover:bg-muted inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm underline underline-offset-4"
            href={sanitizeHref(sourceUrl)}
            rel="noopener noreferrer"
            target="_blank"
          >
            <ExternalLinkIcon className="size-3.5" />
            {t("common.source")}
          </a>
        ) : null}
      </div>
      {hit.address?.textAddress ? (
        <p className="text-sm leading-6 select-text" dir="auto">
          {hit.address.textAddress}
        </p>
      ) : null}
    </section>
  );
};

type RegistryDetailsValue = NonNullable<RegistryHit["details"]>;

const REGISTRY_DATE_FIELDS = new Set([
  "ceasedAt",
  "ceasedOn",
  "closedAt",
  "createdAt",
  "dateEstablished",
  "dateOfCessation",
  "dateOfCreation",
  "dateRegistered",
  "deletedAt",
  "dissolvedAt",
  "effectiveFrom",
  "endedAt",
  "establishedAt",
  "filingDate",
  "from",
  "lastChangeDate",
  "lastEntryAt",
  "lastFilingDate",
  "lastMadeUpTo",
  "nextDue",
  "nextMadeUpTo",
  "openedAt",
  "registeredAt",
  "reportDate",
  "requestDate",
  "setupDate",
  "since",
  "terminatedAt",
  "to",
]);

const getRegistryRecord = (details: RegistryDetailsValue) => {
  switch (details.registry) {
    case "ares":
    case "companies-house":
    case "edgar":
    case "gcis":
    case "orsr":
    case "prh":
    case "recherche-entreprises":
      return details.company;
    case "brreg":
    case "krs":
      return details.entity;
    case "denue":
      return details.establishment;
    case "vies":
      return details.validation;
    default: {
      details satisfies never;
      return panic("Unhandled business registry details");
    }
  }
};

const RegistryDetails = ({ details }: { details: RegistryDetailsValue }) => {
  const t = useTranslations();
  const entries = registryDetailEntries(getRegistryRecord(details)).filter(
    ([key, value]) =>
      value !== null &&
      value !== "" &&
      key !== "name" &&
      key !== "registryUrl" &&
      key !== "vrEnrichmentStatus" &&
      registryDetailLabel(key) !== "search.registryDetails.industryCodes" &&
      !(
        details.registry === "ares" &&
        (key === "statutoryBodies" || key === "actingClause")
      ),
  );
  const enrichmentUnavailable =
    details.registry === "ares" &&
    details.company.vrEnrichmentStatus === "unavailable";

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-medium">{t("common.details")}</h3>
      {enrichmentUnavailable ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("search.registryDetails.enrichmentUnavailable")}
        </p>
      ) : null}
      <Table className="table-fixed">
        <TableBody>
          {entries.map(([key, value]) => (
            <TableRow className="hover:bg-transparent" key={key}>
              <TableHead
                scope="row"
                className="h-auto w-2/5 px-0 py-3 pe-4 align-baseline text-xs leading-5 font-normal wrap-break-word whitespace-normal"
              >
                <RegistryDetailLabel detailKey={key} />
              </TableHead>
              <TableCell className="px-0 py-3 align-baseline text-sm leading-5 wrap-break-word whitespace-normal select-text">
                <RegistryDetailValue
                  registry={details.registry}
                  detailKey={key}
                  value={value}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {details.registry === "ares" ? (
        <AresGovernance company={details.company} />
      ) : null}
    </section>
  );
};

const AresGovernance = ({ company }: { company: AresCompany }) => {
  const t = useTranslations();
  return (
    <div className="space-y-6">
      {company.actingClause ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">
            {t("search.registryDetails.actingClause")}
          </h3>
          <p
            className="text-sm leading-6 whitespace-pre-line select-text"
            dir="auto"
          >
            {company.actingClause}
          </p>
        </section>
      ) : null}
      {company.statutoryBodies.length > 0 ? (
        <section className="space-y-4">
          <h3 className="text-sm font-medium">
            {t("search.registryDetails.statutoryBodies")}
          </h3>
          {company.statutoryBodies.map((body) => (
            <div className="space-y-2" key={body.organName}>
              <h4
                className="text-muted-foreground text-xs font-medium"
                dir="auto"
              >
                {body.organName}
              </h4>
              <ul className="divide-y">
                {body.members.map((member) => (
                  <li
                    className="space-y-1 py-3 first:pt-0"
                    key={JSON.stringify(member)}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                      <span className="font-medium" dir="auto">
                        {member.name}
                      </span>
                      {member.role ? (
                        <span className="text-muted-foreground" dir="auto">
                          {member.role}
                        </span>
                      ) : null}
                    </div>
                    {member.address ? (
                      <p className="text-sm leading-6" dir="auto">
                        {member.address}
                      </p>
                    ) : null}
                    {member.since ? (
                      <p className="text-muted-foreground text-xs leading-5">
                        {t("billing.rates.effectiveFrom")}:{" "}
                        <RegistryDetailValue
                          registry="ares"
                          detailKey="since"
                          value={member.since}
                        />
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
};

const RegistryDetailValue = ({
  value,
  detailKey,
  registry,
}: {
  value: unknown;
  detailKey: string;
  registry: LookupRegistryOption["slug"];
}) => {
  const t = useTranslations();
  const format = useFormatter();
  if (typeof value === "string") {
    if (registry === "ares" && detailKey === "court") {
      return <bdi>{getAresCourtName(value)}</bdi>;
    }
    if (registry === "ares" && detailKey === "legalForm") {
      return <bdi>{getAresLegalFormName(value) ?? value}</bdi>;
    }
    const date = REGISTRY_DATE_FIELDS.has(detailKey)
      ? parseIsoDateLocal(value)
      : null;
    if (date) {
      return (
        <time dateTime={value}>
          {format.dateTime(date, CALENDAR_DATE_FORMAT)}
        </time>
      );
    }
    return <bdi>{value}</bdi>;
  }
  if (typeof value === "number") {
    return format.number(value, {
      useGrouping: false,
      maximumSignificantDigits: 21,
    });
  }
  if (typeof value === "boolean") {
    return value
      ? t("caseLaw.research.answers.yes")
      : t("caseLaw.research.answers.no");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <>—</>;
    }
    return (
      <ul className="flex flex-wrap gap-x-3 gap-y-2">
        {value.map((item: unknown) => (
          <li className="min-w-0 has-[table]:w-full" key={JSON.stringify(item)}>
            <RegistryDetailValue
              registry={registry}
              detailKey={detailKey}
              value={item}
            />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value !== "object" || value === null) {
    return <>—</>;
  }
  return (
    <Table className="table-fixed">
      <TableBody>
        {registryDetailEntries(value).map(([key, child]) =>
          child === null || child === "" ? null : (
            <TableRow className="border-0 hover:bg-transparent" key={key}>
              <TableHead
                scope="row"
                className="h-auto w-2/5 px-0 py-1 pe-2 align-baseline text-xs leading-5 font-normal wrap-break-word whitespace-normal"
              >
                <RegistryDetailLabel detailKey={key} />
              </TableHead>
              <TableCell className="px-0 py-1 align-baseline leading-5 wrap-break-word whitespace-normal">
                <RegistryDetailValue
                  registry={registry}
                  detailKey={key}
                  value={child}
                />
              </TableCell>
            </TableRow>
          ),
        )}
      </TableBody>
    </Table>
  );
};

const RegistryDetailLabel = ({ detailKey }: { detailKey: string }) => {
  const t = useTranslations();
  return t(registryDetailLabel(detailKey));
};

const registryDetailEntries = (value: object): [string, unknown][] =>
  Object.entries(value);

const CompanyRegistryPreviewSkeleton = () => (
  <div className="space-y-4 p-5">
    <Skeleton className="h-6 w-2/3" />
    <Skeleton className="h-3 w-28" />
    <Skeleton className="h-16 w-full" />
    <div className="grid grid-cols-2 gap-3">
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  </div>
);
