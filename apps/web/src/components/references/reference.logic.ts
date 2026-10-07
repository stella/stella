/**
 * The one reference model for chat. Every surface that shows a reference to
 * a file, task, folder, matter, decision, skill or person (the composer chip,
 * the sent user message, the assistant's answer, the ask-user card) converts
 * its own source shape into a `ChatReference` here and renders it through
 * `ReferenceChip`, so the same reference cannot look different in two places.
 *
 * Sources and what they carry:
 * - composer mention attrs: label, entity kind, mime type, matter id;
 * - an optimistic `<entity-mention>` tag in a just-sent message: the same;
 * - a persisted or streamed markdown href: identity and label only (a kind
 *   never crosses the API's trust boundary into persisted text), so the kind
 *   comes from the session's carried hints or a background read.
 *
 * The visual rule (`resolveReferenceVisual`): the glyph says what the
 * reference is (kind icon; a person's avatar), and a reference that belongs
 * to a matter paints that glyph in the matter's colour. The matter colour is
 * an icon colour only, never a fill or a border. Glyphs whose colour already
 * means something (a file type's brand mark) keep it.
 */
import { panic } from "better-result";

import {
  CHAT_DECISION_PASSAGE_HREF_PREFIX,
  isEntityKind,
  parseChatDecisionPassageHref,
  parseChatResourceHref,
  RESOURCE_TYPE,
  resourceRef,
  SKILL_REF_HREF_PREFIX,
  toChatMentionResourceHref,
  toChatResourceHref,
} from "@stll/api-contract";
import type { ChatMentionResourceHref, EntityKind } from "@stll/api-contract";
import type { CaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";

import type { CaseLawDecisionLocator } from "@/components/chat/case-law-open";
import type { EntityIconSource } from "@/components/workspaces/entity-kind-icon";
import { PDF_MIME_TYPE } from "@/consts";
import { DOCX_MIME } from "@/lib/consts";
import { toSafeId } from "@/lib/safe-id";

export type ChatReference =
  | {
      type: "entity";
      entityId: string;
      /** The matter the entity lives in; null when no source names it. */
      matterId: string | null;
      label: string;
      /** Carried kind; null when the source does not carry one. */
      entityKind: EntityKind | null;
      mimeType: string | null;
    }
  | { type: "matter"; matterId: string; label: string }
  | {
      type: "decision";
      locator: CaseLawDecisionLocator;
      /** A passage of the decision the reference points into. */
      anchorId: string | null;
      label: string;
    }
  | { type: "skill"; slug: string; label: string }
  | { type: "user"; userId: string; label: string };

/** What a source string resolved to: a reference, a reference the server
 * marked unresolvable (renders as its plain label), or not a reference. */
export type ParsedReference =
  | { type: "reference"; reference: ChatReference }
  | { type: "unresolved" }
  | null;

// --- Hrefs ------------------------------------------------------------------

/**
 * The server rewrites a citation whose ref was never minted this turn to this
 * href (`CHAT_UNRESOLVED_REF_HREF` in the API's ref registry): a fabricated
 * or mangled mention must render as plain text, never as a real-looking chip.
 */
export const UNRESOLVED_REFERENCE_HREF = "#stella-unresolved-ref";
// Model-facing per-turn refs persisted by older builds. A stable UUID behind
// them is still a reference; a per-turn token (`ent_99`) is not.
const LEGACY_ENTITY_REF_PREFIX = "#stella-entity-ref=";
const LEGACY_MATTER_REF_PREFIX = "#stella-workspace-ref=";
const UUID_SHAPE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether an href is one this module turns into a reference (or into the
 * plain label of an unresolvable one). */
export const isReferenceHref = (href: string): boolean =>
  href === UNRESOLVED_REFERENCE_HREF ||
  parseChatResourceHref(href) !== null ||
  parseChatDecisionPassageHref(href) !== null ||
  href.startsWith(LEGACY_ENTITY_REF_PREFIX) ||
  href.startsWith(LEGACY_MATTER_REF_PREFIX) ||
  href.startsWith(SKILL_REF_HREF_PREFIX);

type HrefContext = {
  /** The matter the surface renders in, for an entity href that names none. */
  renderWorkspaceId?: string | undefined;
};

export const referenceFromHref = (
  href: string,
  label: string,
  { renderWorkspaceId }: HrefContext = {},
): ParsedReference => {
  if (href === UNRESOLVED_REFERENCE_HREF) {
    return { type: "unresolved" };
  }

  if (href.startsWith(LEGACY_ENTITY_REF_PREFIX)) {
    const raw = href.slice(LEGACY_ENTITY_REF_PREFIX.length);
    const separator = raw.indexOf(":");
    const entityId = separator === -1 ? raw : raw.slice(separator + 1);
    if (!UUID_SHAPE_REGEX.test(entityId)) {
      return { type: "unresolved" };
    }
    return asReference({
      type: "entity",
      entityId,
      matterId:
        separator === -1
          ? (renderWorkspaceId ?? null)
          : raw.slice(0, separator),
      label,
      entityKind: null,
      mimeType: null,
    });
  }

  if (href.startsWith(LEGACY_MATTER_REF_PREFIX)) {
    const matterId = href.slice(LEGACY_MATTER_REF_PREFIX.length);
    return UUID_SHAPE_REGEX.test(matterId)
      ? asReference({ type: "matter", matterId, label })
      : { type: "unresolved" };
  }

  const passage = parseChatDecisionPassageHref(href);
  if (passage !== null) {
    // A model occasionally emits a degenerate citation whose text is the bare
    // href or is empty; the anchor is the decision's own paragraph marker, so
    // it reads as a locator rather than as the internal scheme.
    const text = label.trim();
    return asReference({
      type: "decision",
      locator: { type: "ref", ref: passage.decisionId },
      anchorId: passage.anchorId,
      label:
        text.length === 0 ||
        text.toLowerCase().startsWith(CHAT_DECISION_PASSAGE_HREF_PREFIX)
          ? passage.anchorId
          : label,
    });
  }

  if (href.startsWith(SKILL_REF_HREF_PREFIX)) {
    const slug = href.slice(SKILL_REF_HREF_PREFIX.length);
    return slug.length > 0 ? asReference({ type: "skill", slug, label }) : null;
  }

  const target = parseChatResourceHref(href);
  if (target === null) {
    return null;
  }
  switch (target.type) {
    case RESOURCE_TYPE.ENTITY:
      return asReference({
        type: "entity",
        entityId: target.resource.id,
        matterId:
          target.location.type === "workspace"
            ? target.location.workspace.id
            : (renderWorkspaceId ?? null),
        label,
        entityKind: null,
        mimeType: null,
      });
    case RESOURCE_TYPE.WORKSPACE:
      return asReference({
        type: "matter",
        matterId: target.resource.id,
        label,
      });
    case RESOURCE_TYPE.CASE_LAW_DECISION:
      return asReference({
        type: "decision",
        locator: { type: "ref", ref: target.resource.id },
        anchorId: null,
        label,
      });
    case RESOURCE_TYPE.USER:
      return asReference({ type: "user", userId: target.resource.id, label });
    default:
      target satisfies never;
      return panic(`Unhandled reference target: ${String(target)}`);
  }
};

const asReference = (value: ChatReference): ParsedReference => ({
  type: "reference",
  reference: value,
});

/** A link to one of this app's own decision pages, opened in-app. */
export const referenceFromDecisionRoute = (
  params: CaseLawDecisionRouteParams,
  label: string,
): ChatReference => ({
  type: "decision",
  locator: { type: "route", params },
  anchorId: null,
  label,
});

/** The durable href of an entity in a matter, as persisted text carries it. */
export const entityReferenceHref = ({
  entityId,
  matterId,
}: {
  entityId: string;
  matterId: string;
}): ChatMentionResourceHref =>
  toChatMentionResourceHref({
    type: RESOURCE_TYPE.ENTITY,
    resource: resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">(entityId),
    }),
    location: {
      type: "workspace",
      workspace: resourceRef({
        type: RESOURCE_TYPE.WORKSPACE,
        id: toSafeId<"workspace">(matterId),
      }),
    },
  });

// --- Composer mention attrs ---------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (
  record: Record<string, unknown>,
  key: string,
): string | null => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * A composer mention node's attrs (also the `<entity-mention>` tag a
 * just-sent message still holds, read through `mentionTagAttrs`). The
 * entity's matter is `matterId` when the picker recorded it, else the
 * cross-matter `sourceWorkspaceId`, else the matter the surface renders in.
 */
export const referenceFromMentionAttrs = (
  attrs: unknown,
  { renderWorkspaceId }: HrefContext = {},
): ChatReference | null => {
  if (!isRecord(attrs)) {
    return null;
  }
  const id = readString(attrs, "id");
  const label = readString(attrs, "label") ?? "";
  const category = readString(attrs, "category") ?? "entity";
  if (id === null) {
    return null;
  }
  switch (category) {
    case "workspace":
      return { type: "matter", matterId: id, label };
    case "decision":
      return {
        type: "decision",
        locator: { type: "ref", ref: id },
        anchorId: null,
        label,
      };
    case "entity": {
      const kind = attrs["kind"];
      return {
        type: "entity",
        entityId: id,
        matterId:
          readString(attrs, "matterId") ??
          readString(attrs, "sourceWorkspaceId") ??
          renderWorkspaceId ??
          null,
        label,
        entityKind: isEntityKind(kind) ? kind : null,
        mimeType: readString(attrs, "mimeType"),
      };
    }
    default:
      return null;
  }
};

/** The attrs an `<entity-mention data-…>` tag spells, keyed like node attrs. */
export const mentionTagAttrs = (readAttr: (name: string) => string | null) => ({
  id: readAttr("data-id"),
  label: readAttr("data-label"),
  category: readAttr("data-category"),
  kind: readAttr("data-kind"),
  mimeType: readAttr("data-mime-type"),
  matterId: readAttr("data-matter-id"),
  sourceWorkspaceId: readAttr("data-source-workspace-id"),
});

/**
 * The href the API persists for a composer mention
 * (`apps/api/src/lib/markdown/chat-message.ts`), so a just-sent message shows
 * the same link it will show once the server's copy replaces it.
 */
export const mentionAttrsToHref = (attrs: unknown): string | null => {
  if (!isRecord(attrs)) {
    return null;
  }
  const id = readString(attrs, "id");
  const category = readString(attrs, "category");
  if (id === null || category === null) {
    return null;
  }
  switch (category) {
    case "workspace":
      return toChatResourceHref({
        type: RESOURCE_TYPE.WORKSPACE,
        resource: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: toSafeId<"workspace">(id),
        }),
      });
    case "decision":
      return toChatResourceHref({
        type: RESOURCE_TYPE.CASE_LAW_DECISION,
        resource: resourceRef({
          type: RESOURCE_TYPE.CASE_LAW_DECISION,
          id: toSafeId<"caseLawDecision">(id),
        }),
      });
    case "entity": {
      const sourceWorkspaceId = readString(attrs, "sourceWorkspaceId");
      return sourceWorkspaceId === null
        ? toChatResourceHref({
            type: RESOURCE_TYPE.ENTITY,
            resource: resourceRef({
              type: RESOURCE_TYPE.ENTITY,
              id: toSafeId<"entity">(id),
            }),
            location: { type: "render_context" },
          })
        : entityReferenceHref({ entityId: id, matterId: sourceWorkspaceId });
    }
    default:
      return null;
  }
};

// --- Visual -------------------------------------------------------------------

/** What a background read knows about one fact of a reference. */
export type LiveFact<TValue> =
  | { status: "pending" }
  | { status: "missing" }
  | { status: "resolved"; value: TValue };

export type ReferenceLiveFacts = {
  /** The entity itself (entity references only). */
  entity: LiveFact<{
    kind: EntityKind;
    fileName: string | null;
    mimeType: string | null;
  }>;
  /** A kind and mime type this session carried for the entity. */
  hint: { kind: EntityKind; mimeType: string | null } | null;
  /** The stored colour of the reference's matter; `missing` paints the
   * matter's deterministic swatch. */
  matter: LiveFact<{ color: string | null }>;
  /** The person, as the viewer's organization lists them. */
  user: LiveFact<{ name: string; image: string | null; deleted: boolean }>;
};

export type ReferenceGlyph =
  | { type: "entity"; source: EntityIconSource }
  | { type: "matter" }
  | { type: "decision" }
  | { type: "skill" }
  | { type: "user"; name: string; image: string | null; deleted: boolean };

export type ReferenceMatterColor =
  | { type: "none" }
  | { type: "pending" }
  | { type: "resolved"; matterId: string; color: string | null };

export type ReferenceVisual =
  | { type: "plain"; label: string }
  | {
      type: "chip";
      glyph: ReferenceGlyph;
      matter: ReferenceMatterColor;
      label: string;
    };

const DOCUMENT_EXTENSION_MIME: Readonly<Record<string, string>> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: DOCX_MIME,
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  odt: "application/vnd.oasis.opendocument.text",
  pdf: PDF_MIME_TYPE,
  png: "image/png",
  rtf: "application/rtf",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const DOCUMENT_EXTENSION_REGEX = /\.(?<ext>[A-Za-z0-9]{1,8})$/u;

/** An entity label without a known file extension: the icon says the type. */
export const entityDisplayLabel = (label: string): string => {
  const extension = DOCUMENT_EXTENSION_REGEX.exec(label.trim())?.groups?.[
    "ext"
  ];
  if (
    extension === undefined ||
    DOCUMENT_EXTENSION_MIME[extension.toLowerCase()] === undefined
  ) {
    return label;
  }
  return label.trim().replace(DOCUMENT_EXTENSION_REGEX, "");
};

const entityGlyphSource = (
  reference: Extract<ChatReference, { type: "entity" }>,
  facts: ReferenceLiveFacts,
): EntityIconSource => {
  if (facts.entity.status === "resolved") {
    return { type: "resolved", ...facts.entity.value };
  }
  if (reference.entityKind !== null) {
    return {
      type: "resolved",
      kind: reference.entityKind,
      mimeType: reference.mimeType,
    };
  }
  if (facts.hint !== null) {
    return {
      type: "resolved",
      kind: facts.hint.kind,
      mimeType: facts.hint.mimeType,
    };
  }
  // Nothing carried the kind: say so instead of guessing one from the label.
  return facts.entity.status === "pending"
    ? { type: "pending" }
    : { type: "unknown" };
};

const matterColor = (
  matterId: string | null,
  facts: ReferenceLiveFacts,
): ReferenceMatterColor => {
  if (matterId === null) {
    return { type: "none" };
  }
  switch (facts.matter.status) {
    case "pending":
      return { type: "pending" };
    case "missing":
      return { type: "resolved", matterId, color: null };
    case "resolved":
      return { type: "resolved", matterId, color: facts.matter.value.color };
    default:
      facts.matter satisfies never;
      return panic(`Unhandled matter fact: ${String(facts.matter)}`);
  }
};

/** Which visual a reference gets, from what its source carried plus what
 * background reads have returned so far. */
export const resolveReferenceVisual = (
  reference: ChatReference,
  facts: ReferenceLiveFacts,
): ReferenceVisual => {
  switch (reference.type) {
    case "entity":
      return {
        type: "chip",
        glyph: { type: "entity", source: entityGlyphSource(reference, facts) },
        matter: matterColor(reference.matterId, facts),
        label: entityDisplayLabel(reference.label),
      };
    case "matter":
      return {
        type: "chip",
        glyph: { type: "matter" },
        matter: matterColor(reference.matterId, facts),
        label: reference.label,
      };
    case "decision":
      return {
        type: "chip",
        glyph: { type: "decision" },
        matter: { type: "none" },
        label: reference.label,
      };
    case "skill":
      return {
        type: "chip",
        glyph: { type: "skill" },
        matter: { type: "none" },
        label: reference.label,
      };
    case "user":
      // Only people the viewer's organization lists get a person chip; any
      // other id stays the plain text the message already shows.
      if (facts.user.status === "missing") {
        return { type: "plain", label: reference.label };
      }
      return {
        type: "chip",
        glyph:
          facts.user.status === "resolved"
            ? { type: "user", ...facts.user.value }
            : {
                type: "user",
                name: reference.label,
                image: null,
                deleted: false,
              },
        matter: { type: "none" },
        label: reference.label,
      };
    default:
      reference satisfies never;
      return panic(`Unhandled reference: ${String(reference)}`);
  }
};

/** The id a reference's matter colour is read for, if it has a matter. */
export const referenceMatterId = (reference: ChatReference): string | null => {
  switch (reference.type) {
    case "entity":
      return reference.matterId;
    case "matter":
      return reference.matterId;
    case "decision":
    case "skill":
    case "user":
      return null;
    default:
      reference satisfies never;
      return panic(`Unhandled reference: ${String(reference)}`);
  }
};
