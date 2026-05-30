import { Result } from "better-result";

import type { LoadedCatalogueResource } from "@stll/catalogue/install-payloads";
import {
  getSkillResourceKind,
  isAllowedResourcePath,
  normalizeResourcePath,
  parseSkillFile,
  type SkillMetadata,
} from "@stll/skills";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import type {
  ParsedSkillPackage,
  ParsedSkillResource,
} from "../skills/skill-package";

type PersistedSkillResourceKind = ParsedSkillResource["kind"];
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

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

export const toParsedBundledSkillPackage = ({
  expectedSlug,
  resources,
  source,
}: {
  expectedSlug: string;
  resources: readonly ParsedSkillResource[];
  source: string;
}): Result<ParsedSkillPackage, HandlerError> =>
  Result.try({
    try: () => {
      const parsed = parseSkillFile(source);
      assertBundledSkillMetadata({
        expectedSlug,
        metadata: parsed.metadata,
      });
      if (parsed.body.length > LIMITS.agentSkillBodyMaxChars) {
        throw new HandlerError({
          status: 500,
          message: "Bundled skill instructions are too large",
        });
      }

      return {
        body: parsed.body,
        compatibility: parsed.metadata.compatibility ?? null,
        contentHash: hashBundledSkillPackage({
          resources,
          source,
        }),
        description: parsed.metadata.description,
        license: parsed.metadata.license ?? null,
        metadata: parsed.metadata.metadata ?? {},
        name: parsed.metadata.name,
        resources: [...resources],
        sourceUrl: null,
        version: parsed.metadata.version,
      };
    },
    catch: (cause) => {
      if (cause instanceof HandlerError) {
        return cause;
      }
      return new HandlerError({
        status: 500,
        message: `Bundled skill file is invalid: ${expectedSlug}`,
        cause,
      });
    },
  });

export const hashBundledSkillPackage = ({
  resources,
  source,
}: {
  resources: readonly ParsedSkillResource[];
  source: string;
}): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(source);
  for (const resource of resources) {
    hasher.update("\0");
    hasher.update(resource.path);
    hasher.update("\0");
    hasher.update(resource.content);
  }
  return hasher.digest("hex");
};

const assertBundledSkillMetadata = ({
  expectedSlug,
  metadata,
}: {
  expectedSlug: string;
  metadata: SkillMetadata;
}) => {
  if (!SKILL_NAME_PATTERN.test(metadata.name)) {
    throw new HandlerError({
      status: 500,
      message:
        "Bundled skill name must use lowercase letters, digits, and hyphens only",
    });
  }
  if (metadata.name !== expectedSlug) {
    throw new HandlerError({
      status: 500,
      message: `Bundled skill name does not match catalogue slug: ${expectedSlug}`,
    });
  }
  assertFrontmatterField({
    field: "description",
    limit: LIMITS.agentSkillDescriptionMaxChars,
    value: metadata.description,
  });
  assertFrontmatterField({
    field: "version",
    limit: LIMITS.agentSkillVersionMaxChars,
    value: metadata.version,
  });
  assertFrontmatterField({
    field: "license",
    limit: LIMITS.agentSkillLicenseMaxChars,
    value: metadata.license,
  });
  assertFrontmatterField({
    field: "compatibility",
    limit: LIMITS.agentSkillCompatibilityMaxChars,
    value: metadata.compatibility,
  });
  assertFrontmatterMetadata(metadata.metadata);
};

const assertFrontmatterField = ({
  field,
  limit,
  value,
}: {
  field: string;
  limit: number;
  value: string | null | undefined;
}) => {
  if (!value || value.length <= limit) {
    return;
  }

  throw new HandlerError({
    status: 500,
    message: `Bundled skill ${field} is too large`,
  });
};

const assertFrontmatterMetadata = (
  metadata: Record<string, string> | undefined,
) => {
  const entries = Object.entries(metadata ?? {});
  if (entries.length > LIMITS.agentSkillMetadataEntriesMax) {
    throw new HandlerError({
      status: 500,
      message: "Bundled skill metadata has too many entries",
    });
  }

  for (const [key, value] of entries) {
    if (key.length > LIMITS.agentSkillMetadataKeyMaxChars) {
      throw new HandlerError({
        status: 500,
        message: "Bundled skill metadata key is too large",
      });
    }
    if (value.length > LIMITS.agentSkillMetadataValueMaxChars) {
      throw new HandlerError({
        status: 500,
        message: "Bundled skill metadata value is too large",
      });
    }
  }
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
