// What a link in chat text refers to, read with the same rules the web app
// reads it with (`@stll/api-contract/chat-reference-href`), and where the
// phone opens it. Persisted chat text carries a mention or a citation as a
// markdown link whose href names a document, matter or decision and whose
// label is what the person saw; the thread draws it as a chip with that
// label, never as the raw href, and opens it in the app's own screens.

import { panic } from "better-result";
import type { Href } from "expo-router";

import { parseCanonicalChatSourceCitationHref } from "@stll/api-contract";
import { isCaseLawDecisionId } from "@stll/api-contract/case-law-decision-route";
import {
  entityDisplayLabel,
  entityLabelMimeType,
  referenceFromHref,
} from "@stll/api-contract/chat-reference-href";
import type { ChatReference } from "@stll/api-contract/chat-reference-href";

import { entityRoute } from "@/state/search";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME = "application/pdf";

/** A reference as a chip draws it: its label, and what it opens. */
export type ChatTextReference =
  | {
      readonly kind: "entity";
      readonly label: string;
      /** The item's own name, when the text gives it; a citation shows a passage. */
      readonly name: string | null;
      /** The matter it lives in; null when the text names none. */
      readonly matterId: string | null;
      readonly entityId: string;
      /** The file type its label or citation names, when it names one. */
      readonly mimeType: string | null;
    }
  | {
      readonly kind: "matter";
      readonly label: string;
      readonly matterId: string;
    }
  | {
      readonly kind: "decision";
      readonly label: string;
      /** Null for a decision named by its docket, which the phone cannot open yet. */
      readonly decisionId: string | null;
    }
  /** A person, a skill or a source the turn was scoped to: a label alone. */
  | { readonly kind: "label"; readonly label: string };

/**
 * The reference `href` names, written as `label`: a chip, `unresolved` for a
 * reference the server could not stand behind (it reads as its plain
 * label), or undefined when the href is no reference at all. `matterId` is
 * the matter the thread belongs to, for a mention that names none.
 */
export const chatTextReference = (
  href: string,
  label: string,
  matterId: string | undefined,
): ChatTextReference | "unresolved" | undefined => {
  const citation = parseCanonicalChatSourceCitationHref(href);
  if (citation !== null) {
    return {
      kind: "entity",
      label,
      name: null,
      matterId: citation.workspaceId,
      entityId: citation.entityId,
      mimeType: citation.type === "docx-folio" ? DOCX_MIME : PDF_MIME,
    };
  }
  const parsed = referenceFromHref(href, label, {
    renderWorkspaceId: matterId,
  });
  if (parsed === null) {
    return undefined;
  }
  return parsed.type === "unresolved"
    ? "unresolved"
    : toTextReference(parsed.reference);
};

const toTextReference = (reference: ChatReference): ChatTextReference => {
  switch (reference.type) {
    case "entity":
      return {
        kind: "entity",
        label: entityDisplayLabel(reference.label),
        name: entityDisplayLabel(reference.label),
        matterId: reference.matterId,
        entityId: reference.entityId,
        mimeType: reference.mimeType ?? entityLabelMimeType(reference.label),
      };
    case "matter":
      return {
        kind: "matter",
        label: reference.label,
        matterId: reference.matterId,
      };
    case "decision": {
      const { locator } = reference;
      return {
        kind: "decision",
        label: reference.label,
        decisionId:
          locator.type === "ref" && isCaseLawDecisionId(locator.ref)
            ? locator.ref.trim()
            : null,
      };
    }
    case "skill":
    case "user":
    case "corpus":
    case "registry":
    case "connector":
      return { kind: "label", label: reference.label };
    default:
      reference satisfies never;
      return panic(`Unhandled reference: ${String(reference)}`);
  }
};

/**
 * Where tapping a reference goes: a screen of the app, `resolve` for an
 * item whose kind decides its screen and must be read first, or undefined
 * for one that opens nothing.
 */
export type ReferenceTarget =
  | { readonly type: "route"; readonly href: Href }
  | {
      readonly type: "resolve";
      readonly matterId: string;
      readonly entityId: string;
      readonly name: string;
    };

export const referenceTarget = (
  reference: ChatTextReference,
): ReferenceTarget | undefined => {
  switch (reference.kind) {
    case "entity": {
      const { entityId, matterId, mimeType } = reference;
      const name = reference.name ?? "";
      if (matterId === null) {
        return undefined;
      }
      // A file type in its label or citation already says it is a document.
      return mimeType === null
        ? { type: "resolve", matterId, entityId, name }
        : {
            type: "route",
            href: entityRoute({
              entityId,
              entityKind: "document",
              matterName: null,
              name,
              workspaceId: matterId,
            }),
          };
    }
    case "matter":
      return {
        type: "route",
        href: {
          pathname: "/matter/[workspaceId]",
          params: {
            workspaceId: reference.matterId,
            ...(reference.label === "" ? {} : { name: reference.label }),
          },
        },
      };
    case "decision":
      return reference.decisionId === null
        ? undefined
        : {
            type: "route",
            href: {
              pathname: "/law/[decisionId]",
              params: { decisionId: reference.decisionId },
            },
          };
    case "label":
      return undefined;
    default:
      reference satisfies never;
      return panic(`Unhandled reference: ${String(reference)}`);
  }
};
