import { valibotSchema } from "@ai-sdk/valibot";
// oxlint-disable-next-line no-restricted-imports
import { tool } from "ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import type { SafeDb } from "@/api/db";
import { createReadonlyOrgFunctionRegistry } from "@/api/handlers/chat/tools/execute/org-function-registry";
import { readonlyOrgFunctionContracts } from "@/api/handlers/chat/tools/execute/org-manifest";
import { findReadonlyFunctionManifestEntry } from "@/api/handlers/chat/tools/execute/readonly-manifest";
import type { ReadonlyFunctionContract } from "@/api/handlers/chat/tools/execute/readonly-manifest";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { DEFAULT_SANDBOX_LIMITS } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import { runSandbox } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import type { SandboxFunctionRegistry } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
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
      panic(`Duplicate readonly stella function name: ${name}`);
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
    "describe-stella-function": tool({
      description:
        "Return the full JSON Schema details for one readonly " +
        "`stella` function available inside `execute-typescript`. Use this " +
        "only as a fallback when the typed `stella` declarations " +
        "in the system prompt are not enough and you need the " +
        "exact schema for a specific function.",
      inputSchema: valibotSchema(
        v.strictObject({
          name: v.pipe(
            v.string(),
            v.description("Readonly `stella` function name to inspect."),
          ),
        }),
      ),
      // eslint-disable-next-line require-await
      execute: async ({ name }) => {
        const manifestEntry = findReadonlyFunctionManifestEntry({
          contracts: readonlyFunctionContracts,
          name,
        }).unwrap();

        if (!manifestEntry) {
          throw new ChatToolError({
            message: `Unknown readonly stella function: ${name}`,
          });
        }

        return {
          function: manifestEntry,
        };
      },
    }),

    "execute-typescript": tool({
      description:
        "Execute a TypeScript program inside a sandboxed " +
        "QuickJS runtime. The program runs as the body of an " +
        "async function: write top-level statements and `return` " +
        "the value you want back. The only side-effect available " +
        "is `stella.<functionName>(input)`, which calls a " +
        "readonly function. The typed readonly `stella` declarations " +
        "are already in the system prompt; use `describe-stella-function` " +
        "only as a fallback to inspect one function's full JSON Schema " +
        "details. `stella.list*` functions accept optional `limit` and " +
        "numeric `offset` pagination inputs; omit `limit` unless you need " +
        "a smaller page, and never exceed 500. `stella.get*` functions " +
        "require explicit refs and return full results without pagination. " +
        `Detail reads accept up to ${LIMITS.chatExecuteDetailIdsMax.toLocaleString()} refs; ` +
        `content reads accept up to ${LIMITS.chatExecuteContentIdsMax.toLocaleString()} entity refs. When you need ` +
        "multiple independent reads, use `Promise.all()` to fetch them in " +
        "parallel instead of awaiting them one by one. " +
        "`console.log` is a no-op; only the value you `return` comes " +
        "back as the tool output. There is no `fetch`, `process`, " +
        "`require`, filesystem, or network access. " +
        `Code length is limited to ${LIMITS.chatRunCodeMaxLength.toLocaleString()} characters. ` +
        `Execution is bounded to ${DEFAULT_SANDBOX_LIMITS.maxDurationMs.toLocaleString()}ms, ` +
        `${DEFAULT_SANDBOX_LIMITS.maxHostCalls.toLocaleString()} host calls, and ` +
        `${(DEFAULT_SANDBOX_LIMITS.maxReturnBytes / 1024).toLocaleString()} KiB of returned data.`,
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
          return {
            value: result.value.value,
            hostCalls: result.value.hostCalls,
            durationMs: result.value.durationMs,
          };
        }

        throw new ChatToolError({
          message: `Sandbox execution failed (${result.error.reason}): ${result.error.message}`,
        });
      },
    }),
  };
};
