import { panic } from "better-result";

import {
  deriveRefMediationEntry,
  type OutputRefField,
} from "@/api/lib/chat/projection-schema";
import type { ChatRefKind, ChatRefRegistry } from "@/api/lib/chat/ref-registry";

import type { RegistryRefFieldMapEntry } from "./ref-field-map";
import {
  READ_TOOL_REF_FIELD_MAP,
  WRITE_TOOL_REF_FIELD_MAP,
} from "./ref-field-map";

type RefPathSegment = {
  collection: boolean;
  key: string;
};

type OutputRefPath = {
  kind: ChatRefKind;
  segments: readonly RefPathSegment[];
};

const parseRefPath = ({ kind, path }: OutputRefField): OutputRefPath => ({
  kind,
  segments: path.split(".").map((token) => {
    const collection = token.endsWith("[]");
    const key = collection ? token.slice(0, -2) : token;
    if (key.length === 0) {
      panic(`Invalid registry output ref path: ${path}`);
    }
    return { collection, key };
  }),
});

const buildOutputRefPathsByTool = (): ReadonlyMap<
  string,
  readonly OutputRefPath[]
> => {
  const pathsByTool = new Map<string, readonly OutputRefPath[]>();
  const entries: [string, RegistryRefFieldMapEntry][] = [
    ...Object.entries(READ_TOOL_REF_FIELD_MAP),
    ...Object.entries(WRITE_TOOL_REF_FIELD_MAP),
  ];

  for (const [toolName, entry] of entries) {
    if (!entry.chatProjectable) {
      continue;
    }
    const paths = deriveRefMediationEntry(entry.projection).outputRefs.map(
      parseRefPath,
    );
    if (paths.length > 0) {
      pathsByTool.set(toolName, paths);
    }
  }
  return pathsByTool;
};

const OUTPUT_REF_PATHS_BY_TOOL = buildOutputRefPathsByTool();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveAtPath = ({
  index,
  path,
  refRegistry,
  value,
}: {
  index: number;
  path: OutputRefPath;
  refRegistry: ChatRefRegistry;
  value: unknown;
}): unknown => {
  if (index === path.segments.length) {
    return refRegistry.resolveRefId({ kind: path.kind, value });
  }
  if (!isRecord(value)) {
    return value;
  }

  const segment =
    path.segments.at(index) ??
    panic("Registry output ref path ended unexpectedly");
  if (!(segment.key in value)) {
    return value;
  }

  const child = value[segment.key];
  if (segment.collection) {
    if (!Array.isArray(child)) {
      return value;
    }
    return {
      ...value,
      [segment.key]: child.map((item) =>
        resolveAtPath({
          index: index + 1,
          path,
          refRegistry,
          value: item,
        }),
      ),
    };
  }

  return {
    ...value,
    [segment.key]: resolveAtPath({
      index: index + 1,
      path,
      refRegistry,
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
    resolved = resolveAtPath({ index: 0, path, refRegistry, value: resolved });
  }
  return resolved;
};
