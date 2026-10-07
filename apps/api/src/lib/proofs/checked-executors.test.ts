import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { runCheckedSubagentBatch } from "@/api/handlers/chat/tools/spawn-subagents-tool";
import { readCheckedAIConfiguration } from "@/api/lib/ai-config-loader";
import {
  ACCOUNT_ACCESS,
  runCheckedScopedHandler,
} from "@/api/lib/api-handlers";
import { toSafeId } from "@/api/lib/branded-types";
import {
  runCheckedOrganizationFileWrite,
  runCheckedOrganizationFileCopy,
} from "@/api/lib/files/organization-file-usage";
import {
  authorizeOperation,
  withAdmittedOperation,
} from "@/api/lib/proofs/checked-transaction";
import { runCheckedAction } from "@/api/lib/rate-limit/action-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("checked_org");
const userId = toSafeId<"user">("checked_user");

for (const executor of ["write", "copy"] as const) {
  test(`checked file ${executor} ignores substituted caller fields and reservation`, async () => {
    const input = {
      operation: {
        organizationId,
        objectKey: "checked/key",
        sizeBytes: 3,
        metadata: { owner: "checked" },
        write: async () => await Promise.resolve("checked write"),
        copy: async () => await Promise.resolve(Result.ok("checked copy")),
      },
      reservation: { status: "disabled" } as const,
    };
    const authorized = await authorizeOperation({
      kind: "FileWriteReserved",
      input,
      check: async () => await Promise.resolve(Result.ok(undefined)),
    });
    if (Result.isError(authorized)) {
      panic("File evidence fixture refused");
    }
    const result = await authorized.value.execute(async (context) => {
      expect(
        Reflect.set(context.input.value.operation, "objectKey", "other/key"),
      ).toBe(false);
      expect(
        Reflect.set(
          context.input.value.operation,
          "write",
          async () => "other write",
        ),
      ).toBe(false);
      expect(
        Reflect.set(context.input.value.operation.metadata, "owner", "other"),
      ).toBe(false);
      expect(Reflect.set(context.proof.input, "value", context.scratch)).toBe(
        false,
      );
      context.scratch.operation.objectKey = "other/key";
      context.scratch.operation.organizationId =
        toSafeId<"organization">("other_org");
      context.scratch.operation.sizeBytes = 999;
      context.scratch.operation.metadata.owner = "other";
      context.scratch.operation.write = async () =>
        await Promise.resolve("other write");
      context.scratch.operation.copy = async () =>
        await Promise.resolve(Result.ok("other copy"));
      expect(
        Reflect.set(context.scratch.reservation, "status", "reserved"),
      ).toBe(true);
      expect(
        Reflect.set(
          context.scratch.reservation,
          "writeId",
          "other_reservation",
        ),
      ).toBe(true);
      expect(
        Reflect.set(context.scratch.reservation, "organizationId", "other_org"),
      ).toBe(true);
      expect(
        Reflect.set(context.scratch.reservation, "objectKey", "other/key"),
      ).toBe(true);
      expect(context.proof.input.value).toEqual(input);
      expect(
        Object.isFrozen(context.proof.input.value.operation.metadata),
      ).toBe(true);
      const substituted = {
        ...context,
        input: { ...context.input, value: context.scratch },
      };
      return executor === "write"
        ? await runCheckedOrganizationFileWrite(substituted)
        : await runCheckedOrganizationFileCopy(substituted);
    });
    expect(result).toEqual(Result.ok(`checked ${executor}`));
  });
}

test("checked AI configuration ignores substituted actor and nested settings", async () => {
  const authorized = await authorizeOperation({
    kind: "AIConfigurationAllowed",
    input: {
      actor: { organizationId, userId },
      settings: { model: { id: "checked" } },
    },
    check: async () => await Promise.resolve(Result.ok(undefined)),
  });
  if (Result.isError(authorized)) {
    panic("Configuration evidence fixture refused");
  }
  const result = await authorized.value.execute((context) => {
    context.scratch.actor.organizationId =
      toSafeId<"organization">("other_org");
    context.scratch.settings.model.id = "other";
    return readCheckedAIConfiguration({
      ...context,
      input: { ...context.input, value: context.scratch },
    });
  });
  expect(result).toEqual({ model: { id: "checked" } });
});

test("checked scoped handlers use checked dispatch and tenant values with mutable handler state", async () => {
  const input = asTestRaw<
    Parameters<typeof runCheckedScopedHandler>[0]["input"]["value"]
  >({
    ctx: {
      request: new Request("https://example.test/checked"),
      route: "/checked",
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      set: { headers: {} },
    },
    config: {
      permissions: { chat: ["create"] },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "assistant_chat" },
    },
    async *handler(ctx: {
      session: { activeOrganizationId: string };
      user: { id: string };
      set: { headers: Record<string, string> };
    }) {
      ctx.set.headers["x-checked"] = "yes";
      ctx.user.id = "mutable handler state";
      return Result.ok({ organization: ctx.session.activeOrganizationId });
    },
  });
  const authorized = await authorizeOperation({
    kind: "HandlerUsageAllowed",
    input,
    check: async () => await Promise.resolve(Result.ok(undefined)),
  });
  if (Result.isError(authorized)) {
    panic("Scoped evidence fixture refused");
  }
  const result = await authorized.value.execute(async (context) => {
    context.scratch.ctx.session.activeOrganizationId =
      toSafeId<"organization">("other_org");
    context.scratch.handler = async function* () {
      return Result.ok({ organization: "other dispatch" });
    };
    const dispatched = await runCheckedScopedHandler({
      ...context,
      input: { ...context.input, value: context.scratch },
    });
    expect(context.proof.input.value.ctx.user.id).toBe(userId);
    expect(context.scratch.ctx.set.headers).toMatchObject({
      "x-checked": "yes",
    });
    return dispatched;
  });
  expect(result).toEqual({ organization: organizationId });
});

test("checked actions use checked callback, tenant and admission scope", async () => {
  const signal = new AbortController().signal;
  const control = {
    reservePeriod: async () => await Promise.resolve(Result.ok(undefined)),
  };
  const input = {
    organizationId,
    userId,
    costRecorder: null,
    run: async (seenSignal: AbortSignal) => {
      expect(seenSignal).toBe(signal);
      return await Promise.resolve("checked");
    },
  };
  const result = await withAdmittedOperation({
    kind: "ActionAdmitted",
    input,
    admit: async (
      _input,
      execute: (scope: {
        signal: AbortSignal;
        control: typeof control;
      }) => Promise<string>,
    ) => await execute({ signal, control }),
    run: async (context) => {
      context.scratch.organizationId = toSafeId<"organization">("other_org");
      context.scratch.run = async () => await Promise.resolve("other");
      const substituted = {
        ...context,
        input: { ...context.input, value: context.scratch },
        admission: {
          ...context.admission,
          value: { signal: AbortSignal.abort(), control },
        },
      };
      return await runCheckedAction(substituted);
    },
  });
  expect(result).toBe("checked");
});

test("checked subagent batches use checked dispatcher and organization", async () => {
  const calls: string[] = [];
  const input = asTestRaw<
    Parameters<typeof runCheckedSubagentBatch>[0]["input"]["value"]
  >({
    props: {
      organizationId,
      userId,
      workspaceId: null,
      threadId: toSafeId<"chatThread">("checked_thread"),
      delegationDepth: 0,
      managedAIResidency: "eu",
      thirdPartyBoundary: { type: "direct" },
      buildSubagentToolset: () => ({}),
    },
    subagents: [{ task: "checked", expectedOutput: "checked answer" }],
    fastModelInfo: {
      availability: "available",
      keySource: "instance",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    },
    dependencies: {
      runSubagent: async ({
        organizationId: seen,
      }: {
        organizationId: string;
      }) => {
        calls.push(seen);
        return { outcome: "completed", text: "checked", usage: undefined };
      },
    },
  });
  const authorized = await authorizeOperation({
    kind: "SubagentBatchAllowed",
    input,
    check: async () => await Promise.resolve(Result.ok(undefined)),
  });
  if (Result.isError(authorized)) {
    panic("Subagent evidence fixture refused");
  }
  await authorized.value.execute(async (context) => {
    context.scratch.props.organizationId =
      toSafeId<"organization">("other_org");
    const subagent =
      context.scratch.subagents.at(0) ??
      panic("Checked batch fixture has no subagent");
    subagent.task = "other";
    context.scratch.dependencies.runSubagent = async () => ({
      outcome: "completed",
      text: "other",
      usage: undefined,
    });
    const result = await runCheckedSubagentBatch({
      ...context,
      input: { ...context.input, value: context.scratch },
    });
    expect(result).toMatchObject({
      results: [{ status: "completed", result: "checked" }],
    });
  });
  expect(calls).toEqual([organizationId]);
});
