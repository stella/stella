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
 *   comes from the session's carried hints or a background read. The href
 *   is read by `referenceFromHref` in `@stll/api-contract/chat-reference`,
 *   which the phone reads chat text with too.
 *
 * The visual rule (`resolveReferenceVisual`): the glyph says what the
 * reference is (kind icon; a person's avatar), and a reference that belongs
 * to a matter paints that glyph in the matter's colour. The matter colour is
 * an icon colour only, never a fill or a border. Glyphs whose colour already
 * means something (a file type's brand mark) keep it.
 */
import { panic } from "better-result";

import {
  isChatSourceScopeKind,
  isEntityKind,
  parseChatSourceScopeId,
  RESOURCE_TYPE,
  resourceRef,
  toChatMentionResourceHref,
  toChatResourceHref,
  toChatSourceScopeHref,
} from "@stll/api-contract";
import type {
  ChatCorpusScope,
  ChatMentionResourceHref,
  EntityKind,
} from "@stll/api-contract";
import type { CaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";
import {
  entityDisplayLabel,
  sourceScopeReference,
} from "@stll/api-contract/chat-reference-href";
import type { ChatReference } from "@stll/api-contract/chat-reference-href";

import type { EntityIconSource } from "@/components/workspaces/entity-kind-icon";
import { toSafeId } from "@/lib/safe-id";

/** A link to one of this app's own decision pages, opened in-app. */
export const referenceFromDecisionRoute = (
  params: CaseLawDecisionRouteParams,
  label: string,
): ChatReference => ({
  type: "decision",
  locator: { type: "route", params },
  paragraph: null,
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
  if (isChatSourceScopeKind(category)) {
    const scope = parseChatSourceScopeId(category, id);
    return scope === null ? null : sourceScopeReference(scope, label);
  }
  switch (category) {
    case "workspace":
      return { type: "matter", matterId: id, label };
    case "decision":
      return {
        type: "decision",
        locator: { type: "ref", ref: id },
        paragraph: null,
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
  if (isChatSourceScopeKind(category)) {
    const scope = parseChatSourceScopeId(category, id);
    return scope === null ? null : toChatSourceScopeHref(scope);
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
  | { type: "corpus"; corpus: ChatCorpusScope["corpus"] }
  | { type: "registry" }
  | { type: "connector" }
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
    case "corpus":
      return {
        type: "chip",
        glyph: { type: "corpus", corpus: reference.scope.corpus },
        matter: { type: "none" },
        label: reference.label,
      };
    case "registry":
    case "connector":
      return {
        type: "chip",
        glyph: { type: reference.type },
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
    case "corpus":
    case "registry":
    case "connector":
    case "user":
      return null;
    default:
      reference satisfies never;
      return panic(`Unhandled reference: ${String(reference)}`);
  }
};
