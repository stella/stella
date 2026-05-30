import { Result } from "better-result";

import type { LoadedCatalogueResource } from "@stll/catalogue";
import {
  getSkillResourceKind,
  isAllowedResourcePath,
  normalizeResourcePath,
} from "@stll/skills";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import type { ParsedSkillResource } from "../skills/skill-package";

type PersistedSkillResourceKind = ParsedSkillResource["kind"];

export const toParsedBundledSkillResources = (
  resourceFiles: readonly LoadedCatalogueResource[],
): Result<ParsedSkillResource[], HandlerError> => {
  if (resourceFiles.length > LIMITS.agentSkillResourcesPerSkill) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Bundled skill has too many resources",
      }),
    );
  }

  const resources: ParsedSkillResource[] = [];
  for (const resourceFile of resourceFiles) {
    const normalizedPath = normalizeResourcePath(resourceFile.path);
    if (!isAllowedResourcePath(normalizedPath)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: `Bundled skill resource is not allowed: ${normalizedPath}`,
        }),
      );
    }

    if (resourceFile.content.length > LIMITS.agentSkillResourceMaxChars) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: `Bundled skill resource is too large: ${normalizedPath}`,
        }),
      );
    }

    const kind = persistedSkillResourceKind(normalizedPath);
    if (kind === null) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: `Bundled skill resource kind is not supported: ${normalizedPath}`,
        }),
      );
    }

    resources.push({
      content: resourceFile.content,
      kind,
      path: normalizedPath,
      sizeBytes: resourceFile.sizeBytes,
    });
  }

  return Result.ok(resources.toSorted((a, b) => a.path.localeCompare(b.path)));
};

export const hashBundledSkillPackage = ({
  body,
  resources,
}: {
  body: string;
  resources: readonly ParsedSkillResource[];
}): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  for (const resource of resources) {
    hasher.update("\0");
    hasher.update(resource.path);
    hasher.update("\0");
    hasher.update(resource.content);
  }
  return hasher.digest("hex");
};

const persistedSkillResourceKind = (
  path: string,
): PersistedSkillResourceKind | null => {
  const kind = getSkillResourceKind(path);
  switch (kind) {
    case "asset":
    case "knowledge":
    case "prompt":
    case "reference":
    case "script":
    case "template":
      return kind;
    case "other":
    case null:
      return null;
    default:
      return null;
  }
};
