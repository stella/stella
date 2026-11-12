/**
 * What a link in chat text refers to, read the same way by every surface
 * that draws chat text (the web app and the phone). Persisted text carries a
 * reference as a markdown link whose href names it (`#stella-entity=`,
 * `#stella-decision=`, …) and whose label is what the person saw; a surface
 * draws it as a chip, never as the raw href.
 */
import { panic } from "better-result";

import { SKILL_REF_HREF_PREFIX } from "./agent-skills";
import type { BusinessRegistrySlug } from "./business-registries";
import type { CaseLawDecisionRouteParams } from "./case-law-decision-route";
import type { ChatCorpusScope } from "./chat-corpus-scope";
import {
  CHAT_DECISION_PASSAGE_HREF_PREFIX,
  parseChatDecisionPassageHref,
} from "./chat-decision-passage-link";
import type { ChatSourceScope } from "./chat-source-scope";
import {
  chatSourceScopeKindOfHref,
  parseChatSourceScopeHref,
} from "./chat-source-scope";
import type { EntityKind } from "./entity-kinds";
import { parseChatResourceHref } from "./resource-link";
import { RESOURCE_TYPE } from "./resource-ref";

/**
 * How a chat link names a decision: by the id or docket a
 * `#stella-decision=` href carries, or by the route params of the decision
 * page's own URL.
 */
export type ChatDecisionLocator =
  | { type: "ref"; ref: string }
  | { type: "route"; params: CaseLawDecisionRouteParams };

/** The block of a decision a reference points into. */
export type CitedDecisionParagraph = {
  anchorId: string;
  /** The number the court printed on the block, as the server stamped it. */
  courtParagraphNumber: number | null;
};

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
      locator: ChatDecisionLocator;
      /** A passage of the decision the reference points into. */
      paragraph: CitedDecisionParagraph | null;
      label: string;
    }
  | { type: "skill"; slug: string; label: string }
  | { type: "user"; userId: string; label: string }
  /** A public corpus the turn is scoped to ("@Case law · Czechia"). */
  | { type: "corpus"; scope: ChatCorpusScope; label: string }
  /** A business registry the turn is scoped to ("@ARES"). */
  | { type: "registry"; registry: BusinessRegistrySlug; label: string }
  /** One of the user's MCP connectors the turn is scoped to. */
  | { type: "connector"; connector: string; label: string };

/** A source chip's scope as the reference it renders. */
export const sourceScopeReference = (
  scope: ChatSourceScope,
  label: string,
): ChatReference => {
  switch (scope.kind) {
    case "corpus":
      return {
        type: "corpus",
        scope: { corpus: scope.corpus, country: scope.country },
        label,
      };
    case "registry":
      return { type: "registry", registry: scope.registry, label };
    case "connector":
      return { type: "connector", connector: scope.connector, label };
    default:
      scope satisfies never;
      return panic(`Unhandled source scope: ${String(scope)}`);
  }
};

/** What a source string resolved to: a reference, a reference the server
 * marked unresolvable (renders as its plain label), or not a reference. */
export type ParsedReference =
  | { type: "reference"; reference: ChatReference }
  | { type: "unresolved" }
  | null;

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

/** Whether an href is one `referenceFromHref` turns into a reference (or
 * into the plain label of an unresolvable one). */
export const isReferenceHref = (href: string): boolean =>
  href === UNRESOLVED_REFERENCE_HREF ||
  parseChatResourceHref(href) !== null ||
  parseChatDecisionPassageHref(href) !== null ||
  href.startsWith(LEGACY_ENTITY_REF_PREFIX) ||
  href.startsWith(LEGACY_MATTER_REF_PREFIX) ||
  href.startsWith(SKILL_REF_HREF_PREFIX) ||
  chatSourceScopeKindOfHref(href) !== null;

type HrefContext = {
  /** The matter the surface renders in, for an entity href that names none. */
  renderWorkspaceId?: string | undefined;
};

const asReference = (value: ChatReference): ParsedReference => ({
  type: "reference",
  reference: value,
});

/** The reference a link names, with `label` as the text it was written with. */
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
      paragraph: {
        anchorId: passage.anchorId,
        courtParagraphNumber: passage.courtParagraphNumber,
      },
      label:
        text.length === 0 ||
        text.toLowerCase().startsWith(CHAT_DECISION_PASSAGE_HREF_PREFIX)
          ? passage.anchorId
          : label,
    });
  }

  if (chatSourceScopeKindOfHref(href) !== null) {
    const scope = parseChatSourceScopeHref(href);
    return scope === null
      ? { type: "unresolved" }
      : asReference(sourceScopeReference(scope, label));
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
        paragraph: null,
        label,
      });
    case RESOURCE_TYPE.USER:
      return asReference({ type: "user", userId: target.resource.id, label });
    default:
      target satisfies never;
      return panic(`Unhandled reference target: ${String(target)}`);
  }
};

const DOCUMENT_EXTENSION_MIME: Readonly<Record<string, string>> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  odt: "application/vnd.oasis.opendocument.text",
  pdf: "application/pdf",
  png: "image/png",
  rtf: "application/rtf",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const DOCUMENT_EXTENSION_REGEX = /\.(?<ext>[A-Za-z0-9]{1,8})$/u;

/** The file type a label's known extension names, or null. */
export const entityLabelMimeType = (label: string): string | null => {
  const extension = DOCUMENT_EXTENSION_REGEX.exec(label.trim())?.groups?.[
    "ext"
  ];
  return extension === undefined
    ? null
    : (DOCUMENT_EXTENSION_MIME[extension.toLowerCase()] ?? null);
};

/** An entity label without a known file extension: the icon says the type. */
export const entityDisplayLabel = (label: string): string =>
  entityLabelMimeType(label) === null
    ? label
    : label.trim().replace(DOCUMENT_EXTENSION_REGEX, "");
