import { Result } from "better-result";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { ChatMessage } from "@/api/handlers/chat/types";
import type {
  ChatRefRegistry,
  ChatRefTarget,
} from "@/api/lib/chat/ref-registry";
import type { ChatExactRefContext } from "@/api/lib/chat/ref-token";

type CollectMessageExactRefContextsProps = {
  parts: readonly ChatMessage["parts"][number][];
  refRegistry: ChatRefRegistry;
};

const toExactRefContext = ({
  target,
  toolCallId,
}: {
  target: ChatRefTarget;
  toolCallId: string;
}): ChatExactRefContext => {
  switch (target.kind) {
    case "contact":
      return {
        kind: target.kind,
        ref: target.ref,
        resource: resourceRef({
          type: RESOURCE_TYPE.CONTACT,
          id: target.target.contactId,
        }),
        toolCallId,
      };
    case "entity":
      return {
        kind: target.kind,
        ref: target.ref,
        resource: resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: target.target.entityId,
        }),
        toolCallId,
        workspace: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: target.target.workspaceId,
        }),
      };
    case "matter":
      return {
        kind: target.kind,
        ref: target.ref,
        resource: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: target.target.workspaceId,
        }),
        toolCallId,
      };
    case "property":
      return {
        kind: target.kind,
        ref: target.ref,
        resource: resourceRef({
          type: RESOURCE_TYPE.PROPERTY,
          id: target.target.propertyId,
        }),
        toolCallId,
      };
    default:
      return target satisfies never;
  }
};

/** Persist only exact registered refs present in this message's tool values. */
export const collectMessageExactRefContexts = ({
  parts,
  refRegistry,
}: CollectMessageExactRefContextsProps): ChatExactRefContext[] => {
  const contexts = new Map<string, ChatExactRefContext>();

  const collect = (toolCallId: string, value: unknown): void => {
    for (const target of refRegistry.collectRefTargets(value)) {
      const context = toExactRefContext({ target, toolCallId });
      contexts.set(JSON.stringify([toolCallId, target.ref]), context);
    }
  };

  for (const part of parts) {
    if (part.type === "tool-call") {
      collect(part.id, part);
      continue;
    }
    if (part.type !== "tool-result") {
      continue;
    }
    const content = part.content;
    if (typeof content !== "string") {
      continue;
    }
    const parsed = Result.try((): unknown => JSON.parse(content));
    if (Result.isOk(parsed)) {
      collect(part.toolCallId, parsed.value);
    }
  }

  return [...contexts.values()];
};

export const toChatRefTargets = (
  contexts: readonly ChatExactRefContext[],
): ChatRefTarget[] =>
  contexts.map((context) => {
    switch (context.kind) {
      case "contact":
        return {
          kind: context.kind,
          ref: context.ref,
          target: { contactId: context.resource.id },
        };
      case "entity":
        return {
          kind: context.kind,
          ref: context.ref,
          target: {
            entityId: context.resource.id,
            workspaceId: context.workspace.id,
          },
        };
      case "matter":
        return {
          kind: context.kind,
          ref: context.ref,
          target: { workspaceId: context.resource.id },
        };
      case "property":
        return {
          kind: context.kind,
          ref: context.ref,
          target: { propertyId: context.resource.id },
        };
      default:
        return context satisfies never;
    }
  });
