import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { Building2Icon, ShieldCheckIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";

import { formatPreviewDate } from "./format";
import { PREVIEW_MATTERS } from "./mock-data";
import type { PreviewMatter } from "./mock-data";
import { FeaturePreviewSurface } from "./surface";
import type { FeaturePreviewProps } from "./surface";

export type ContactsPreviewLabels = {
  /** Heading of the section filled from the company registry. */
  businessRegistry: string;
  /** Heading of the matters the contact is linked to. */
  matters: string;
};

/** The contact's content. Registry field titles (`details[].label`,
 *  `incorporatedOn.label`) are the registry's own, as the app shows them, so
 *  they come with the data rather than the labels. */
export type ContactsPreviewData = {
  company: {
    name: string;
    legalForm: string;
    status: string;
    /** The registry's name, beside the section heading. */
    registry: string;
    details: readonly { label: string; value: string }[];
    /** `date` is `YYYY-MM-DD`. */
    incorporatedOn: { label: string; date: string };
  };
  linkedMatters: readonly PreviewMatter[];
};

/** A company contact filled from its business registry: legal form, status,
 *  registered details and the matters it appears in. */
export const ContactsPreview = ({
  labels,
  locale,
  data: { company, linkedMatters } = DEFAULT_DATA,
  className,
}: FeaturePreviewProps<ContactsPreviewLabels, ContactsPreviewData>) => (
  <FeaturePreviewSurface
    className={className}
    icon={<Building2Icon className="text-muted-foreground size-4 shrink-0" />}
    title={company.name}
  >
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="truncate">{company.legalForm}</span>
        <span className="text-success flex shrink-0 items-center gap-1 font-medium">
          <span className="size-1.5 rounded-full bg-current" />
          {company.status}
        </span>
      </div>
      <section className="flex min-w-0 flex-col gap-2">
        <h3 className="text-muted-foreground flex items-center gap-1.5 font-medium">
          <ShieldCheckIcon className="size-3.5 shrink-0" />
          {labels.businessRegistry}
          <span className="text-foreground-subtle font-normal">
            · {company.registry}
          </span>
        </h3>
        <DetailsGrid className="gap-y-1.5">
          {company.details.map((detail) => (
            <DetailsItem key={detail.label} label={detail.label}>
              {detail.value}
            </DetailsItem>
          ))}
          <DetailsItem label={company.incorporatedOn.label}>
            {formatPreviewDate({
              locale,
              date: company.incorporatedOn.date,
              options: { day: "numeric", month: "long", year: "numeric" },
            })}
          </DetailsItem>
        </DetailsGrid>
      </section>
      <section className="flex min-w-0 flex-col gap-1.5">
        <h3 className="text-muted-foreground font-medium">{labels.matters}</h3>
        <ul className="flex flex-col gap-1">
          {linkedMatters.map((matter) => (
            <li className="flex min-w-0 items-center gap-2" key={matter.id}>
              <MatterIcon className="size-3.5 shrink-0" matter={matter} />
              <span className="truncate">{matter.name}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  </FeaturePreviewSurface>
);

// The default content; see `mock-data.ts`.
const DEFAULT_DATA = {
  company: {
    name: "Meridian Freight Ltd",
    legalForm: "Private limited company",
    status: "Active",
    registry: "Companies House",
    details: [
      { label: "Company number", value: "09876543" },
      {
        label: "Registered office",
        value: "Unit 4, Quayside Park, Bristol BS1 6XX",
      },
      {
        label: "SIC code",
        value: "52290 – Other transportation support activities",
      },
    ],
    incorporatedOn: { label: "Incorporated on", date: "2015-03-04" },
  },
  linkedMatters: [PREVIEW_MATTERS.cargo, PREVIEW_MATTERS.lease],
} as const satisfies ContactsPreviewData;
