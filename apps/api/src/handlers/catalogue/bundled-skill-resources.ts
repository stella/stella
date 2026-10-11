import { panic, Result } from "better-result";

import type { LoadedCatalogueResource } from "@stll/catalogue/install-payloads";
import {
  hashSkillPackage,
  validateSkillPackage,
  type SkillPackageDiagnostic,
} from "@stll/skills";

import { skillRequirableToolNames } from "@/api/lib/agent-skills/required-tools-validation";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ParsedSkillPackage } from "@/api/lib/skills/skill-package";

const encoder = new TextEncoder();

export const toParsedBundledSkillPackage = ({
  expectedSlug,
  resourceFiles,
  source,
}: {
  expectedSlug: string;
  resourceFiles: readonly LoadedCatalogueResource[];
  source: string;
}): Result<ParsedSkillPackage, HandlerError> => {
  const validated = validateSkillPackage({
    files: [
      { content: source, path: "SKILL.md" },
      ...resourceFiles.map(({ content, path, sizeBytes }) => ({
        content,
        path,
        sizeBytes,
      })),
    ],
    tools: { known: skillRequirableToolNames(), type: "check" },
  });
  if (validated.isErr()) {
    return Result.err(toBundledSkillError(validated.error[0]));
  }
  const { body, metadata, resources } = validated.value;
  if (metadata.name !== expectedSlug) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: `Bundled skill name does not match catalogue slug: ${expectedSlug}`,
      }),
    );
  }

  return Result.ok({
    body,
    compatibility: metadata.compatibility ?? null,
    description: metadata.description,
    entrypointHash: hashSkillPackage({ resources, source }),
    license: metadata.license ?? null,
    metadata: metadata.metadata ?? {},
    name: metadata.name,
    resources: resources.map((resource) => ({
      ...resource,
      sizeBytes:
        resource.sizeBytes ?? encoder.encode(resource.content).byteLength,
    })),
    sourceUrl: null,
    version: metadata.version,
  });
};

const toBundledSkillError = (
  diagnostic: SkillPackageDiagnostic | undefined,
): HandlerError => {
  if (diagnostic === undefined) {
    return panic("Invalid bundled skill package has at least one diagnostic");
  }
  return new HandlerError({
    status: 500,
    message: `Bundled skill package is invalid: ${diagnostic.type}`,
  });
};
