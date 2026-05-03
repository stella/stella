import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import type { SafeDb } from "@/api/db";
import { createReadonlyOrgFunctionRegistry } from "@/api/handlers/chat/tools/execute/org-function-registry";
import { readonlyOrgFunctionContracts } from "@/api/handlers/chat/tools/execute/org-manifest";
import {
  buildReadonlyFunctionManifest,
  findReadonlyFunctionManifestEntry,
} from "@/api/handlers/chat/tools/execute/readonly-manifest";
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
        "Discover the readonly `stella` API available inside " +
        "`execute-typescript`. Call with no input to list every " +
        "available function name + one-line description. Call " +
        "with `{name}` to fetch one function's full JSON Schema " +
        "(input, output, types). The catalog is NOT pre-loaded in " +
        "the system prompt — call this whenever you need to " +
        "compose a `stella.*` query.",
      inputSchema: valibotSchema(
        v.strictObject({
          name: v.optional(
            v.pipe(
              v.string(),
              v.description(
                "Readonly `stella` function name to inspect. " +
                  "Omit to list all available functions.",
              ),
            ),
          ),
        }),
      ),
      // eslint-disable-next-line require-await
      execute: async ({ name }) => {
        if (name === undefined) {
          const manifest = buildReadonlyFunctionManifest(
            readonlyFunctionContracts,
          ).unwrap();
          return {
            functions: manifest.map((entry) => ({
              name: entry.name,
              description: entry.description,
            })),
          };
        }

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
        "Escape hatch for arbitrary readonly queries the focused " +
        "tools can't express (cross-matter search, joins, " +
        "aggregations). Runs a TypeScript program inside a " +
        "sandboxed QuickJS runtime; the program is the body of an " +
        "async function — write top-level statements and `return` " +
        "the value you want back. The only side-effect is " +
        "`stella.<functionName>(input)`. The function catalog is " +
        "NOT in the system prompt — call `describe-stella-function` " +
        "(no input) to list available functions, then with `{name}` " +
        "for one function's full schema. `console.log` is a no-op; " +
        "only the returned value comes back. No `fetch`, `process`, " +
        "`require`, filesystem, or network access. Limits: code " +
        `≤${LIMITS.chatRunCodeMaxLength.toLocaleString()} chars, ` +
        `≤${DEFAULT_SANDBOX_LIMITS.maxDurationMs.toLocaleString()}ms, ` +
        `≤${DEFAULT_SANDBOX_LIMITS.maxHostCalls.toLocaleString()} host calls, ` +
        `≤${(DEFAULT_SANDBOX_LIMITS.maxReturnBytes / 1024).toLocaleString()} KiB returned.`,
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
