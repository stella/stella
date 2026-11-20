import type { ComponentProps, ReactNode } from "react";

import { useParams } from "@tanstack/react-router";

import type { ContactType } from "@stll/api-contract";
import { BidiText } from "@stll/ui/bidi-text";
import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { BuildingIcon, PlusIcon, UserIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";

import { usePendingCache } from "@/components/pending-cache";
import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { cachedContactSummary } from "@/lib/contacts/cached-contact.logic";
import type { CachedContactSummary } from "@/lib/contacts/cached-contact.logic";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";
import {
  DetailSectionSkeleton,
  labelledDetailRows,
  unnamedDetailRows,
} from "@/routes/_protected.contacts/-components/detail-section.pending";

/** A contact page's sections, by what they hold. */
export type ContactDetailSection =
  | "identity"
  | "personalDetails"
  | "communication"
  | "billing"
  | "owners"
  | "customFields"
  | "notes"
  | "matters";

const PERSON_SECTIONS: readonly ContactDetailSection[] = [
  "identity",
  "personalDetails",
  "communication",
  "owners",
  "customFields",
  "notes",
  "matters",
];

const ORGANIZATION_SECTIONS: readonly ContactDetailSection[] = [
  "identity",
  "communication",
  "billing",
  "owners",
  "customFields",
  "notes",
  "matters",
];

/**
 * The sections a contact's page shows, in their order: a person's details
 * after the identity, an organization's billing after its communication. The
 * page and its loading view both lay out this list.
 */
export const contactDetailSections = (
  type: ContactType,
): readonly ContactDetailSection[] =>
  type === "person" ? PERSON_SECTIONS : ORGANIZATION_SECTIONS;

/** The sections that take the grid's whole width. */
export const CONTACT_WIDE_SECTION_CLASS = "md:col-span-2";

/** A field of a contact's identity section. */
type ContactIdentityField = {
  field:
    | "displayName"
    | "prefix"
    | "firstName"
    | "middleName"
    | "lastName"
    | "suffix"
    | "organizationName";
  labelKey: PendingTextKey;
};

/** The identity rows, in the page's order, for each type. */
export const CONTACT_IDENTITY_FIELDS: Record<
  ContactType,
  readonly ContactIdentityField[]
> = {
  person: [
    { field: "displayName", labelKey: "common.displayName" },
    { field: "prefix", labelKey: "contacts.fields.prefix" },
    { field: "firstName", labelKey: "contacts.fields.firstName" },
    { field: "middleName", labelKey: "contacts.fields.middleName" },
    { field: "lastName", labelKey: "contacts.fields.lastName" },
    { field: "suffix", labelKey: "contacts.fields.suffix" },
  ],
  organization: [
    { field: "displayName", labelKey: "common.displayName" },
    { field: "organizationName", labelKey: "common.organizationName" },
  ],
};

/** The identity section's heading: the contact's type. */
export const CONTACT_TYPE_LABEL_KEYS = {
  person: "contacts.type.person",
  organization: "contacts.type.organization",
} as const satisfies Record<ContactType, PendingTextKey>;

/** The billing rows every member sees, before the rates only billing
 *  readers do. */
const BILLING_ROW_LABELS: readonly PendingTextKey[] = [
  "contacts.fields.registrationNumber",
  "common.taxId",
  "common.vatId",
  "contacts.fields.vatPayer",
  "contacts.fields.paymentTermDays",
];

/** The contact page's frame: the header over the grid of sections. */
export const ContactDetailShell = ({
  header,
  children,
}: {
  header: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
    {header}
    <div className="grid gap-6 md:grid-cols-2">{children}</div>
  </div>
);

/**
 * The header row: the type's icon, the name and its type, then the actions,
 * which wrap under the name on a narrow screen instead of running off the
 * edge (the breadcrumb already leads back to the list).
 */
export const ContactDetailHeader = ({
  actions,
  badge,
  icon,
  name,
}: {
  actions: ReactNode;
  badge: ReactNode;
  icon: ReactNode;
  name: ReactNode;
}) => (
  <div className="flex flex-wrap items-center gap-3">
    <div className="flex min-w-0 items-center gap-2">
      {icon}
      <h1 className="text-xl font-bold">{name}</h1>
      <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs">
        {badge}
      </span>
    </div>
    <div className="ms-auto flex flex-wrap items-center gap-2">{actions}</div>
  </div>
);

/** The type's icon before the name. */
export const ContactTypeIcon = ({ type }: { type: ContactType }) =>
  type === "person" ? (
    <UserIcon className="text-muted-foreground size-5" />
  ) : (
    <BuildingIcon className="text-muted-foreground size-5" />
  );

/** "New matter" in the header: its button and its content. */
export const NEW_MATTER_BUTTON = { size: "sm", variant: "outline" } as const;
export const NewMatterButtonContent = ({ label }: { label: ReactNode }) => (
  <>
    <PlusIcon className="size-4" />
    {label}
  </>
);

/** "Delete contact" in the header. */
export const DELETE_CONTACT_BUTTON = {
  size: "sm",
  variant: "destructive",
} as const;

type ContactSectionSkeletonProps = ComponentProps<typeof DetailSectionSkeleton>;

/** Each section before the read: its heading and rows, by the contact's type
 *  where the cache knows it. */
const CONTACT_SECTION_SKELETONS = {
  identity: (type) => ({
    rows: labelledDetailRows(
      CONTACT_IDENTITY_FIELDS[type ?? "organization"].map(
        (row) => row.labelKey,
      ),
    ),
    title: type === null ? null : CONTACT_TYPE_LABEL_KEYS[type],
  }),
  personalDetails: () => ({
    rows: unnamedDetailRows(2),
    title: "contacts.personalDetails",
  }),
  communication: () => ({
    rows: unnamedDetailRows(3),
    title: "contacts.communication.title",
  }),
  billing: () => ({
    rows: labelledDetailRows(BILLING_ROW_LABELS),
    title: "contacts.billing.title",
  }),
  owners: () => ({
    rows: labelledDetailRows([
      "contacts.attorneys.originating",
      "contacts.attorneys.responsible",
    ]),
    title: "contacts.attorneys.title",
  }),
  customFields: () => ({
    className: CONTACT_WIDE_SECTION_CLASS,
    rows: unnamedDetailRows(1),
    title: "contacts.customFields.title",
  }),
  notes: () => ({
    className: CONTACT_WIDE_SECTION_CLASS,
    rows: unnamedDetailRows(2),
    title: "common.notes",
  }),
  matters: () => ({
    className: CONTACT_WIDE_SECTION_CLASS,
    rows: unnamedDetailRows(2),
    title: "contacts.mattersAsClient",
  }),
} as const satisfies Record<
  ContactDetailSection,
  (type: ContactType | null) => ContactSectionSkeletonProps
>;

const ContactDetailHeaderPending = ({
  canCreateMatter,
  canDeleteContact,
  summary,
}: {
  canCreateMatter: boolean;
  canDeleteContact: boolean;
  summary: CachedContactSummary | null;
}) => (
  <ContactDetailHeader
    actions={
      // The invoice composer shows only for a client with active matters,
      // which only the contact's read says: it is left out, before the rest.
      <>
        {canCreateMatter && (
          <ButtonFace
            size={NEW_MATTER_BUTTON.size}
            variant={NEW_MATTER_BUTTON.variant}
          >
            <NewMatterButtonContent
              label={<PendingText barClassName="w-20" id="common.newMatter" />}
            />
          </ButtonFace>
        )}
        {canDeleteContact && (
          <ButtonFace
            size={DELETE_CONTACT_BUTTON.size}
            variant={DELETE_CONTACT_BUTTON.variant}
          >
            <PendingText barClassName="w-24" id="contacts.deleteContact" />
          </ButtonFace>
        )}
      </>
    }
    badge={
      summary === null ? (
        <FaceLabelPending className="w-12" />
      ) : (
        <PendingText
          barClassName="w-12"
          id={CONTACT_TYPE_LABEL_KEYS[summary.type]}
        />
      )
    }
    icon={
      summary === null ? (
        <Skeleton className="size-5 rounded-full" />
      ) : (
        <ContactTypeIcon type={summary.type} />
      )
    }
    name={
      summary === null ? (
        <FaceLabelPending className="w-48" />
      ) : (
        <BidiText>{summary.displayName}</BidiText>
      )
    }
  />
);

/**
 * A contact's page before its read: the header and the sections of the
 * contact's type as the cache already knows it (a contacts list, an earlier
 * visit). A contact the cache has not seen draws an organization's sections
 * with bars for its name and type: the type decides the sections, and only
 * the read says which it is.
 */
const ContactDetailPendingView = () => {
  const contactId = useParams({
    strict: false,
    select: (params) => params.contactId,
  });
  const cache = usePendingCache();
  const summary =
    cache === null || contactId === undefined
      ? null
      : cachedContactSummary(cache, contactId);
  const type = summary?.type ?? null;
  return (
    <ContactDetailShell
      header={
        <ContactDetailHeaderPending
          canCreateMatter={
            cache !== null && cachedRoleGrants(cache, { workspace: ["create"] })
          }
          canDeleteContact={
            cache !== null && cachedRoleGrants(cache, { contact: ["delete"] })
          }
          summary={summary}
        />
      }
    >
      {contactDetailSections(type ?? "organization").map((section) => (
        <DetailSectionSkeleton
          key={section}
          {...CONTACT_SECTION_SKELETONS[section](type)}
        />
      ))}
    </ContactDetailShell>
  );
};

export const ContactDetailPending = framePendingView(ContactDetailPendingView);
