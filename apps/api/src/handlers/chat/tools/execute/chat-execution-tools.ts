import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import type { SafeDb } from "@/api/db";
import {
  DESCRIBE_STELLA_API_TOOL_DESCRIPTION,
  RUN_STELLA_QUERY_TOOL_DESCRIPTION,
} from "@/api/handlers/chat/tools/execute/chat-execution-tool-descriptions";
import { createReadonlyOrgFunctionRegistry } from "@/api/handlers/chat/tools/execute/org-function-registry";
import { readonlyOrgFunctionContracts } from "@/api/handlers/chat/tools/execute/org-manifest";
import type { ReadonlyFunctionContract } from "@/api/handlers/chat/tools/execute/readonly-manifest";
import {
  buildReadonlyFunctionManifest,
  findReadonlyFunctionManifestEntry,
} from "@/api/handlers/chat/tools/execute/readonly-manifest";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type { SandboxFunctionRegistry } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import { runSandbox } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import { createReadonlyWorkspaceFunctionRegistry } from "@/api/handlers/chat/tools/execute/workspace-function-registry";
import { readonlyWorkspaceFunctionContracts } from "@/api/handlers/chat/tools/execute/workspace-manifest";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

type CreateChatExecutionToolsProps = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  refRegistry: ChatRefRegistry;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

const readonlyFunctionContracts: readonly ReadonlyFunctionContract[] = [
  ...readonlyOrgFunctionContracts,
  ...readonlyWorkspaceFunctionContracts,
];

type MergeSandboxRegistriesProps = {
  orgRegistry: SandboxFunctionRegistry;
  workspaceRegistry: SandboxFunctionRegistry;
};

const mergeSandboxRegistries = ({
  orgRegistry,
  workspaceRegistry,
}: MergeSandboxRegistriesProps): SandboxFunctionRegistry => {
  const mergedRegistry: SandboxFunctionRegistry = { ...orgRegistry };

  for (const [name, fn] of Object.entries(workspaceRegistry)) {
    if (name in mergedRegistry) {
      panic(`Duplicate readonly read function name: ${name}`);
    }

    mergedRegistry[name] = fn;
  }

  return mergedRegistry;
};

type BuildReadonlySandboxRegistryProps = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  refRegistry: ChatRefRegistry;
  safeDb: SafeDb;
};

const buildReadonlySandboxRegistry = ({
  accessibleWorkspaceIds,
  organizationId,
  refRegistry,
  safeDb,
}: BuildReadonlySandboxRegistryProps): SandboxFunctionRegistry => {
  const orgRegistry = createReadonlyOrgFunctionRegistry({
    allowedWorkspaceIds: accessibleWorkspaceIds,
    organizationId,
    refRegistry,
    safeDb,
  });

  const workspaceRegistry = createReadonlyWorkspaceFunctionRegistry({
    allowedWorkspaceIds: accessibleWorkspaceIds,
    organizationId,
    refRegistry,
    safeDb,
  });

  return mergeSandboxRegistries({
    orgRegistry,
    workspaceRegistry,
  });
};

export const createChatExecutionTools = ({
  accessibleWorkspaceIds,
  organizationId,
  refRegistry,
  safeDb,
  userId,
}: CreateChatExecutionToolsProps) => {
  const readonlySandboxRegistry = buildReadonlySandboxRegistry({
    accessibleWorkspaceIds,
    organizationId,
    refRegistry,
    safeDb,
  });

  return {
    "describe-stella-api": tool({
      description: DESCRIBE_STELLA_API_TOOL_DESCRIPTION,
      inputSchema: valibotSchema(
        v.strictObject({
          name: v.optional(
            v.pipe(
              v.string(),
              v.description(
                "Readonly `read` function name to inspect. " +
                  "Omit to list all available functions.",
              ),
            ),
          ),
        }),
      ),
      execute: async ({ name }) => {
        if (name === undefined) {
          const manifest = buildReadonlyFunctionManifest(
            readonlyFunctionContracts,
          ).unwrap();
          return await Promise.resolve({
            functions: manifest.map((entry) => ({
              name: entry.name,
              summary: entry.summary,
              outputShape: entry.outputShape,
            })),
          });
        }

        const manifestEntry = findReadonlyFunctionManifestEntry({
          contracts: readonlyFunctionContracts,
          name,
        }).unwrap();

        if (!manifestEntry) {
          throw new ChatToolError({
            message: `Unknown readonly read function: ${name}`,
          });
        }

        return await Promise.resolve({
          function: manifestEntry,
        });
      },
    }),

    "run-stella-query": tool({
      description: RUN_STELLA_QUERY_TOOL_DESCRIPTION,
      inputSchema: valibotSchema(
        v.strictObject({
          code: v.pipe(
            v.string(),
            v.maxLength(LIMITS.chatRunCodeMaxLength),
            v.description("TypeScript source to execute in the sandbox."),
          ),
        }),
      ),
      execute: async ({ code }) => {
        const result = await runSandbox({
          concurrencyKey: userId,
          source: code,
          registry: readonlySandboxRegistry,
        });

        if (Result.isOk(result)) {
          return { value: result.value.value };
        }

        throw new ChatToolError({
          message: `Sandbox execution failed (${result.error.reason}): ${result.error.message}`,
        });
      },
    }),
  };
};
