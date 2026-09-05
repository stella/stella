import { panic } from "better-result";

import {
  deriveRefMediationEntry,
  type EntityWorkspaceSource,
  type OutputRefField,
} from "@/api/lib/chat/projection-schema";
import type { ChatRefKind, ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type {
  ChatEntityRefContext,
  ChatRefInputState,
} from "@/api/lib/chat/ref-token";
import { isRecord } from "@/api/lib/type-guards";

import { NATIVE_CHAT_REF_POLICY } from "./native-chat-ref-policy";
import type { RegistryRefFieldMapEntry } from "./ref-field-map";
import {
  READ_TOOL_REF_FIELD_MAP,
  WRITE_TOOL_REF_FIELD_MAP,
} from "./ref-field-map";

type RefPathSegment = {
  collection: boolean;
  key: string;
};

type OutputRefPath =
  | {
      kind: Exclude<ChatRefKind, "entity">;
      segments: readonly RefPathSegment[];
    }
  | {
      kind: "entity";
      segments: readonly RefPathSegment[];
      workspace: EntityWorkspaceSource;
    };

const parseRefPath = (field: OutputRefField): OutputRefPath => {
  const segments = field.path.split(".").map((token) => {
    const collection = token.endsWith("[]");
    const key = collection ? token.slice(0, -2) : token;
    if (key.length === 0) {
      panic(`Invalid registry output ref path: ${field.path}`);
    }
    return { collection, key };
  });
  return field.kind === "entity"
    ? { kind: field.kind, segments, workspace: field.workspace }
    : { kind: field.kind, segments };
};

const buildOutputRefPathsByTool = (): ReadonlyMap<
  string,
  readonly OutputRefPath[]
> => {
  const pathsByTool = new Map<string, readonly OutputRefPath[]>();
  const entries: [string, RegistryRefFieldMapEntry][] = [
    ...Object.entries(READ_TOOL_REF_FIELD_MAP),
    ...Object.entries(WRITE_TOOL_REF_FIELD_MAP),
  ];

  for (const [toolName, policy] of Object.entries(NATIVE_CHAT_REF_POLICY)) {
    pathsByTool.set(toolName, policy.outputRefs.map(parseRefPath));
  }

  for (const [toolName, entry] of entries) {
    if (!entry.chatProjectable) {
      continue;
    }
    const paths = deriveRefMediationEntry(entry.projection).outputRefs.map(
      parseRefPath,
    );
    if (paths.length > 0) {
      if (pathsByTool.has(toolName)) {
        panic(`Duplicate chat output ref policy: ${toolName}`);
      }
      pathsByTool.set(toolName, paths);
    }
  }
  return pathsByTool;
};

const OUTPUT_REF_PATHS_BY_TOOL = buildOutputRefPathsByTool();

const readScalarPath = (root: unknown, path: string): unknown => {
  let value = root;
  for (const key of path.split(".")) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
};

const findEntityInputContext = ({
  contexts,
  input,
  param,
}: {
  contexts: readonly ChatEntityRefContext[];
  input: unknown;
  param: string;
}): ChatEntityRefContext | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }
  const entityId = input[param];
  return contexts.find((context) => context.entity.id === entityId);
};

const getEntityWorkspaceId = ({
  contexts,
  input,
  rawContainer,
  rawRoot,
  workspace,
}: {
  contexts: readonly ChatEntityRefContext[];
  input: unknown;
  rawContainer: Record<string, unknown> | undefined;
  rawRoot: unknown;
  workspace: EntityWorkspaceSource;
}): unknown => {
  switch (workspace.from) {
    case "sibling":
      return rawContainer?.[workspace.key];
    case "outputPath":
      return readScalarPath(rawRoot, workspace.path);
    case "inputParam":
      return isRecord(input) ? input[workspace.param] : undefined;
    case "inputEntity":
    case "inputEntityWorkspace":
      return findEntityInputContext({
        contexts,
        input,
        param: workspace.param,
      })?.workspace.id;
    default:
      workspace satisfies never;
      return panic(`Unhandled workspace: ${String(workspace)}`);
  }
};

type RefValueTransform = (props: {
  path: OutputRefPath;
  rawContainer: Record<string, unknown> | undefined;
  rawRoot: unknown;
  value: unknown;
}) => unknown;

const transformAtPath = ({
  index,
  path,
  rawContainer,
  rawRoot,
  rawValue,
  transform,
  value,
}: {
  index: number;
  path: OutputRefPath;
  rawContainer: Record<string, unknown> | undefined;
  rawRoot: unknown;
  rawValue: unknown;
  transform: RefValueTransform;
  value: unknown;
}): unknown => {
  if (index === path.segments.length) {
    return transform({ path, rawContainer, rawRoot, value });
  }
  if (!isRecord(value) || !isRecord(rawValue)) {
    return value;
  }

  const segment =
    path.segments.at(index) ??
    panic("Registry output ref path ended unexpectedly");
  if (!(segment.key in value) || !(segment.key in rawValue)) {
    return value;
  }

  const child = value[segment.key];
  const rawChild = rawValue[segment.key];
  if (segment.collection) {
    if (!Array.isArray(child) || !Array.isArray(rawChild)) {
      return value;
    }
    return {
      ...value,
      [segment.key]: child.map((item, itemIndex) => {
        const rawItem: unknown = rawChild.at(itemIndex);
        return transformAtPath({
          index: index + 1,
          path,
          rawContainer: isRecord(rawItem) ? rawItem : undefined,
          rawRoot,
          rawValue: rawItem,
          transform,
          value: item,
        });
      }),
    };
  }

  return {
    ...value,
    [segment.key]: transformAtPath({
      index: index + 1,
      path,
      rawContainer: rawValue,
      rawRoot,
      rawValue: rawChild,
      transform,
      value: child,
    }),
  };
};

export type ResolveRegistryToolOutputRefsProps = {
  output: unknown;
  refRegistry: ChatRefRegistry;
  toolName: string;
};

/** Resolve only output paths annotated as refs by this registry tool. */
export const resolveRegistryToolOutputRefs = ({
  output,
  refRegistry,
  toolName,
}: ResolveRegistryToolOutputRefsProps): unknown => {
  const paths = OUTPUT_REF_PATHS_BY_TOOL.get(toolName);
  if (paths === undefined) {
    return output;
  }

  let resolved = output;
  for (const path of paths) {
    resolved = transformAtPath({
      index: 0,
      path,
      rawContainer: undefined,
      rawRoot: output,
      rawValue: output,
      transform: ({ path: refPath, value }) =>
        refRegistry.resolveRefId({ kind: refPath.kind, value }),
      value: resolved,
    });
  }
  return resolved;
};

export type HydrateRegistryToolOutputRefsProps = {
  entityContexts?: readonly ChatEntityRefContext[] | undefined;
  input?: unknown;
  inputState: ChatRefInputState;
  output: unknown;
  refRegistry: ChatRefRegistry;
  toolName: string;
};

/** Hydrate the same declared paths the persistence-side inverse resolves. */
export const hydrateRegistryToolOutputRefs = ({
  entityContexts = [],
  input,
  inputState,
  output,
  refRegistry,
  toolName,
}: HydrateRegistryToolOutputRefsProps): unknown => {
  const paths = OUTPUT_REF_PATHS_BY_TOOL.get(toolName);
  if (paths === undefined) {
    return output;
  }

  let hydrated = output;
  for (const path of paths) {
    hydrated = transformAtPath({
      index: 0,
      path,
      rawContainer: undefined,
      rawRoot: output,
      rawValue: output,
      transform: ({ path: refPath, rawContainer, rawRoot, value }) =>
        refRegistry.hydrateRefId({
          inputState,
          kind: refPath.kind,
          value,
          workspaceId:
            refPath.kind === "entity"
              ? getEntityWorkspaceId({
                  contexts: entityContexts,
                  input,
                  rawContainer,
                  rawRoot,
                  workspace: refPath.workspace,
                })
              : undefined,
        }),
      value: hydrated,
    });
  }
  return hydrated;
};
