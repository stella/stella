import type { ContactEmail, ContactPhone } from "@/api/db/schema-validators";
import { defineTextFieldSpec } from "@/api/mcp/text-field-spec";
import type { McpTextFieldSpec } from "@/api/mcp/tool-types";

// --- Text-field specs (plan 049, Option B) --------------------------------

/**
 * list_matters, list mode: one matter per row, scoped under its own matter id
 * (a matter's workspace id IS its anonymization scope). Both fields already
 * ride in the served payload, so no external attribution is needed.
 */
type ListedMatter = { id: string; name: string; reference: string };
type ListMattersListPayload = { matters: readonly ListedMatter[] };

export const LIST_MATTERS_LIST_TEXT_FIELD_SPECS: readonly McpTextFieldSpec<ListMattersListPayload>[] =
  [
    defineTextFieldSpec({
      path: "matters[].name",
      items: (payload: ListMattersListPayload) => payload.matters,
      scope: (matter: ListedMatter) => matter.id,
      read: (matter: ListedMatter) => matter.name,
      apply: (matter: ListedMatter, value) => {
        matter.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "matters[].reference",
      items: (payload: ListMattersListPayload) => payload.matters,
      scope: (matter: ListedMatter) => matter.id,
      read: (matter: ListedMatter) => matter.reference,
      apply: (matter: ListedMatter, value) => {
        matter.reference = value;
      },
    }),
  ];

/**
 * list_matters, detail mode (one matter's overview): every field below
 * belongs to the one matter this response describes, so `payload.matter.id`
 * is the anonymization scope throughout — including the nested
 * entity/contact/member cards, which carry no workspace id of their own on
 * the wire. Each nested item selector pairs the item with that scope id
 * read straight off the payload, so no request-scoped closure is needed.
 */
type MatterOverviewMatter = {
  clientName: string | null;
  id: string;
  name: string;
  reference: string;
};
type MatterOverviewEntity = {
  assignedTo: string | null;
  createdBy: string | null;
  name: string;
};
type MatterOverviewContact = { displayName: string };
type MatterOverviewMember = { name: string };
type MatterOverviewPayload = {
  contacts: readonly MatterOverviewContact[];
  matter: MatterOverviewMatter;
  members: readonly MatterOverviewMember[];
  overview: { recentEntities: readonly MatterOverviewEntity[] };
};

const matterOverviewMatterItems = (
  payload: MatterOverviewPayload,
): readonly [MatterOverviewMatter] => [payload.matter];

type EntityWithScope = { entity: MatterOverviewEntity; workspaceId: string };
const matterOverviewEntityItems = (
  payload: MatterOverviewPayload,
): readonly EntityWithScope[] =>
  payload.overview.recentEntities.map((entity) => ({
    entity,
    workspaceId: payload.matter.id,
  }));

type ContactWithScope = {
  contact: MatterOverviewContact;
  workspaceId: string;
};
const matterOverviewContactItems = (
  payload: MatterOverviewPayload,
): readonly ContactWithScope[] =>
  payload.contacts.map((contact) => ({
    contact,
    workspaceId: payload.matter.id,
  }));

type MemberWithScope = { member: MatterOverviewMember; workspaceId: string };
const matterOverviewMemberItems = (
  payload: MatterOverviewPayload,
): readonly MemberWithScope[] =>
  payload.members.map((member) => ({
    member,
    workspaceId: payload.matter.id,
  }));

export const MATTER_OVERVIEW_TEXT_FIELD_SPECS: readonly McpTextFieldSpec<MatterOverviewPayload>[] =
  [
    defineTextFieldSpec({
      path: "matter.name",
      items: matterOverviewMatterItems,
      scope: (matter: MatterOverviewMatter) => matter.id,
      read: (matter: MatterOverviewMatter) => matter.name,
      apply: (matter: MatterOverviewMatter, value) => {
        matter.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "matter.reference",
      items: matterOverviewMatterItems,
      scope: (matter: MatterOverviewMatter) => matter.id,
      read: (matter: MatterOverviewMatter) => matter.reference,
      apply: (matter: MatterOverviewMatter, value) => {
        matter.reference = value;
      },
    }),
    defineTextFieldSpec({
      path: "matter.clientName",
      items: matterOverviewMatterItems,
      scope: (matter: MatterOverviewMatter) => matter.id,
      read: (matter: MatterOverviewMatter) => matter.clientName,
      apply: (matter: MatterOverviewMatter, value) => {
        matter.clientName = value;
      },
    }),
    defineTextFieldSpec({
      path: "overview.recentEntities[].name",
      items: matterOverviewEntityItems,
      scope: (item: EntityWithScope) => item.workspaceId,
      read: (item: EntityWithScope) => item.entity.name,
      apply: (item: EntityWithScope, value) => {
        item.entity.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "overview.recentEntities[].createdBy",
      items: matterOverviewEntityItems,
      scope: (item: EntityWithScope) => item.workspaceId,
      read: (item: EntityWithScope) => item.entity.createdBy,
      apply: (item: EntityWithScope, value) => {
        item.entity.createdBy = value;
      },
    }),
    defineTextFieldSpec({
      path: "overview.recentEntities[].assignedTo",
      items: matterOverviewEntityItems,
      scope: (item: EntityWithScope) => item.workspaceId,
      read: (item: EntityWithScope) => item.entity.assignedTo,
      apply: (item: EntityWithScope, value) => {
        item.entity.assignedTo = value;
      },
    }),
    defineTextFieldSpec({
      path: "contacts[].displayName",
      items: matterOverviewContactItems,
      scope: (item: ContactWithScope) => item.workspaceId,
      read: (item: ContactWithScope) => item.contact.displayName,
      apply: (item: ContactWithScope, value) => {
        item.contact.displayName = value;
      },
    }),
    defineTextFieldSpec({
      path: "members[].name",
      items: matterOverviewMemberItems,
      scope: (item: MemberWithScope) => item.workspaceId,
      read: (item: MemberWithScope) => item.member.name,
      apply: (item: MemberWithScope, value) => {
        item.member.name = value;
      },
    }),
  ];

/**
 * search_across_matters: hits span multiple matters, each already carrying
 * its own `workspaceId` on the wire (P2 per-item attribution).
 */
type SearchAcrossMattersHit = {
  headline: string | null;
  name: string;
  workspaceId: string;
  workspaceName: string | null;
};
type SearchAcrossMattersPayload = { hits: readonly SearchAcrossMattersHit[] };

export const SEARCH_ACROSS_MATTERS_TEXT_FIELD_SPECS: readonly McpTextFieldSpec<SearchAcrossMattersPayload>[] =
  [
    defineTextFieldSpec({
      path: "hits[].name",
      items: (payload: SearchAcrossMattersPayload) => payload.hits,
      scope: (hit: SearchAcrossMattersHit) => hit.workspaceId,
      read: (hit: SearchAcrossMattersHit) => hit.name,
      apply: (hit: SearchAcrossMattersHit, value) => {
        hit.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "hits[].headline",
      items: (payload: SearchAcrossMattersPayload) => payload.hits,
      scope: (hit: SearchAcrossMattersHit) => hit.workspaceId,
      read: (hit: SearchAcrossMattersHit) => hit.headline,
      apply: (hit: SearchAcrossMattersHit, value) => {
        hit.headline = value;
      },
    }),
    defineTextFieldSpec({
      path: "hits[].workspaceName",
      items: (payload: SearchAcrossMattersPayload) => payload.hits,
      scope: (hit: SearchAcrossMattersHit) => hit.workspaceId,
      read: (hit: SearchAcrossMattersHit) => hit.workspaceName,
      apply: (hit: SearchAcrossMattersHit, value) => {
        hit.workspaceName = value;
      },
    }),
  ];

/**
 * read_content_across_matters: a single document, windowed after
 * anonymization (P8). The window co-declaration in the handler is untouched;
 * only the `name`/`text` textFields construction migrates here. `workspaceId`
 * already rides in the payload (stripped by nothing — this tool has no
 * compat-style field-stripping), so it is read straight off the item.
 */
type ReadContentAcrossMattersPayload = {
  name: string;
  text: string;
  workspaceId: string;
};

export const READ_CONTENT_ACROSS_MATTERS_TEXT_FIELD_SPECS: readonly McpTextFieldSpec<ReadContentAcrossMattersPayload>[] =
  [
    defineTextFieldSpec({
      path: "name",
      items: (payload: ReadContentAcrossMattersPayload) => [payload],
      scope: (item: ReadContentAcrossMattersPayload) => item.workspaceId,
      read: (item: ReadContentAcrossMattersPayload) => item.name,
      apply: (item: ReadContentAcrossMattersPayload, value) => {
        item.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "text",
      items: (payload: ReadContentAcrossMattersPayload) => [payload],
      scope: (item: ReadContentAcrossMattersPayload) => item.workspaceId,
      read: (item: ReadContentAcrossMattersPayload) => item.text,
      apply: (item: ReadContentAcrossMattersPayload, value) => {
        item.text = value;
      },
    }),
  ];

/**
 * read_contact: contacts are organization-scoped (no owning workspace), so
 * `organizationId` is the anonymization scope for every field. Unlike the
 * per-item/per-matter cases above, `organizationId` is not part of the served
 * payload, so it is threaded in as a builder argument. `STELLA_TOOL_DEFINITIONS`
 * below calls this same builder with a placeholder id purely to derive the
 * documented `textFields` path list — `deriveTextFieldPaths` only reads each
 * spec's static `path`, never `scope`, so the placeholder never affects the
 * declaration.
 */
type ContactPayload = {
  displayName: string;
  emails: readonly ContactEmail[];
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  phones: readonly ContactPhone[];
};

export const buildContactTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<ContactPayload>[] => [
  defineTextFieldSpec({
    path: "displayName",
    items: (payload: ContactPayload) => [payload],
    scope: () => organizationId,
    read: (item: ContactPayload) => item.displayName,
    apply: (item: ContactPayload, value) => {
      item.displayName = value;
    },
  }),
  defineTextFieldSpec({
    path: "firstName",
    items: (payload: ContactPayload) => [payload],
    scope: () => organizationId,
    read: (item: ContactPayload) => item.firstName,
    apply: (item: ContactPayload, value) => {
      item.firstName = value;
    },
  }),
  defineTextFieldSpec({
    path: "lastName",
    items: (payload: ContactPayload) => [payload],
    scope: () => organizationId,
    read: (item: ContactPayload) => item.lastName,
    apply: (item: ContactPayload, value) => {
      item.lastName = value;
    },
  }),
  defineTextFieldSpec({
    path: "organizationName",
    items: (payload: ContactPayload) => [payload],
    scope: () => organizationId,
    read: (item: ContactPayload) => item.organizationName,
    apply: (item: ContactPayload, value) => {
      item.organizationName = value;
    },
  }),
  defineTextFieldSpec({
    path: "emails[].label",
    items: (payload: ContactPayload) => payload.emails,
    scope: () => organizationId,
    read: (email: ContactEmail) => email.label,
    apply: (email: ContactEmail, value) => {
      email.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "emails[].address",
    items: (payload: ContactPayload) => payload.emails,
    scope: () => organizationId,
    read: (email: ContactEmail) => email.address,
    apply: (email: ContactEmail, value) => {
      email.address = value;
    },
  }),
  defineTextFieldSpec({
    path: "phones[].label",
    items: (payload: ContactPayload) => payload.phones,
    scope: () => organizationId,
    read: (phone: ContactPhone) => phone.label,
    apply: (phone: ContactPhone, value) => {
      phone.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "phones[].number",
    items: (payload: ContactPayload) => payload.phones,
    scope: () => organizationId,
    read: (phone: ContactPhone) => phone.number,
    apply: (phone: ContactPhone, value) => {
      phone.number = value;
    },
  }),
];
