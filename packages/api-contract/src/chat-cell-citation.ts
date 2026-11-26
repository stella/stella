/**
 * The link an answer cites one tabular-review cell by: a document's value for
 * one extracted property, in the matter that holds both.
 *
 * The model writes it with this turn's refs (`ent_N`, `prop_N`); the server
 * rewrites that into this canonical form before the answer is streamed or
 * stored, so the link survives a reload and no raw id reaches the model.
 */

import { isUuid } from "@stll/uuid-codec";

import { toSafeId } from "./safe-id";
import type { SafeId } from "./safe-id";

export const CHAT_CELL_CITATION_HREF_PREFIX = "#stella-cell=";

export type ChatCellCitationTarget = {
  entityId: SafeId<"entity">;
  propertyId: SafeId<"property">;
  workspaceId: SafeId<"workspace">;
};

export type ChatCellCitationHref =
  `${typeof CHAT_CELL_CITATION_HREF_PREFIX}${string}`;

/** A candidate href inside Markdown: it runs to the link's `)`, `>` or a space. */
const HREF_IN_TEXT_REGEX = /#stella-cell=[^\s)>]*/gu;

export const toChatCellCitationHref = ({
  entityId,
  propertyId,
  workspaceId,
}: ChatCellCitationTarget): ChatCellCitationHref =>
  `${CHAT_CELL_CITATION_HREF_PREFIX}${workspaceId}:${entityId}:${propertyId}`;

export const parseChatCellCitationHref = (
  href: string,
): ChatCellCitationTarget | null => {
  if (!href.startsWith(CHAT_CELL_CITATION_HREF_PREFIX)) {
    return null;
  }
  const [workspaceId, entityId, propertyId, ...rest] = href
    .slice(CHAT_CELL_CITATION_HREF_PREFIX.length)
    .split(":");
  if (
    rest.length > 0 ||
    workspaceId === undefined ||
    entityId === undefined ||
    propertyId === undefined ||
    !isUuid(workspaceId) ||
    !isUuid(entityId) ||
    !isUuid(propertyId)
  ) {
    return null;
  }
  return {
    entityId: toSafeId<"entity">(entityId),
    propertyId: toSafeId<"property">(propertyId),
    workspaceId: toSafeId<"workspace">(workspaceId),
  };
};

/** Every cell citation in `text`, with each well-formed one replaced. */
export const replaceChatCellCitationHrefs = (
  text: string,
  replace: (target: ChatCellCitationTarget) => string,
): string =>
  text.includes(CHAT_CELL_CITATION_HREF_PREFIX)
    ? text.replaceAll(HREF_IN_TEXT_REGEX, (candidate) => {
        const target = parseChatCellCitationHref(candidate);
        return target === null ? candidate : replace(target);
      })
    : text;
