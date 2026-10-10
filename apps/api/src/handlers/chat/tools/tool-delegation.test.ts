import { describe, expect, test } from "bun:test";

import {
  BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  MCP_CHAT_TOOL_POLICY_KINDS,
} from "@stll/api-contract";
import { roles } from "@stll/permissions";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { getChatTools } from "@/api/handlers/chat/tools/chat-tools";
import type { GetChatToolsProps } from "@/api/handlers/chat/tools/chat-tools";
import { NATIVE_CHAT_TOOL_DELEGATIONS } from "@/api/handlers/chat/tools/tool-delegation";
import type { ChatToolDelegation } from "@/api/handlers/chat/tools/tool-delegation";
import { canEditActiveSkill } from "@/api/lib/agent-skills/skills";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { loadCapabilityEndpoint } from "@/api/mcp/capability-tools";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const memberRoles = Object.keys(roles).map((role) => {
  if (!isMemberRole(role)) {
    throw new TypeError(`Permission registry has an unknown role: ${role}`);
  }
  return role;
});

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const userId = toSafeId<"user">("22222222-2222-4222-8222-222222222222");
const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);
const skillId = toSafeId<"agentSkill">("44444444-4444-4444-8444-444444444444");
const threadId = toSafeId<"chatThread">("55555555-5555-4555-8555-555555555555");
const unusedSafeDb: SafeDb = async () => {
  throw new TypeError("Registration must not access the database");
};
const unusedScopedDb: ScopedDb = async () => {
  throw new TypeError("Registration must not access the database");
};
const recordAuditEvent: AuditRecorder = async () => undefined;

const registrationProps = (memberRole: MemberRole) =>
  ({
    memberRole: sessionMemberRole(memberRole),
    memoryEnabled: true,
    orgAIConfig: null,
    managedAIResidency: "eu",
    organizationId,
    userId,
    userEmail: "member@example.test",
    workspaceId,
    requestWorkspaceId: workspaceId,
    threadId,
    pastChatScope: { type: "all-chats" },
    thirdPartyBoundary: { type: "raw" },
    safeDb: unusedSafeDb,
    scopedDb: unusedScopedDb,
    pinServerValidatedWorkspaceId: () => true,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      pinnedIds: [],
      accessibleWorkspaceIds: [workspaceId],
    }),
    workspaceStatusById: new Map([[workspaceId, "active"]]),
    refRegistry: createChatRefRegistry(),
    toolDefectMemo: createChatToolDefectMemo(),
    hasActiveDocxEditClient: true,
    hasActiveDocxFileClient: true,
    docxSuggestionSurface: "file-overlay",
    activeFile: {
      entityId: toSafeId<"entity">("66666666-6666-4666-8666-666666666666"),
      currentVersionId: toSafeId<"entityVersion">(
        "77777777-7777-4777-8777-777777777777",
      ),
      fileFieldId: toSafeId<"field">("88888888-8888-4888-8888-888888888888"),
      supportsDocxEdits: true,
    },
    webSearchEnabled: false,
    webSearchProviders: { webSearchProvider: null, urlFetcher: null },
    registryDispatch: BUSINESS_REGISTRY_DISPATCH,
    activeSkillContext: {
      source: "installed",
      id: skillId,
      origin: "authored",
      toolName: "sample-skill",
      displayName: "Sample skill",
      description: "Sample instructions",
      body: "# Sample",
      version: null,
      resources: [{ path: "references/sample.md" }],
      requiredTools: [],
      documentedChatReads: [],
      excludedChatTools: [],
      // The active-skill resolver supplies this preauthorized field in production.
      editable: canEditActiveSkill({
        memberRole: sessionMemberRole(memberRole),
        origin: "authored",
        scope: "private",
        skillUserId: userId,
        userId,
      }),
    },
    recordAuditEvent,
    resolveMemorySourceWorkspaceIds: () => [],
  }) as const satisfies GetChatToolsProps;

type InspectDelegatedRegistrationsOptions = {
  declarations: Readonly<Record<string, ChatToolDelegation>>;
  registrations: readonly { role: MemberRole; tools: ChatToolMap }[];
};

const inspectDelegatedRegistrations = async ({
  declarations,
  registrations,
}: InspectDelegatedRegistrationsOptions) => {
  const violations: {
    toolName: string;
    capability: string;
    role: MemberRole;
  }[] = [];
  for (const [toolName, delegation] of Object.entries(declarations)) {
    if (delegation.type === "waiver") {
      continue;
    }
    const capability =
      delegation.type === "execution-mode" ? delegation.server : delegation;
    const registeredRoles = registrations
      .filter(({ tools }) => {
        const tool = tools[toolName];
        return (
          tool !== undefined &&
          (delegation.type !== "execution-mode" ||
            ("execute" in tool && typeof tool.execute === "function"))
        );
      })
      .map(({ role }) => role);
    if (registeredRoles.length === 0) {
      throw new TypeError(
        `Delegation ${toolName} has no exercised registration`,
      );
    }
    const endpoint = await loadCapabilityEndpoint(capability.delegatesTo);
    if (endpoint?.config.permissions === undefined) {
      throw new TypeError(
        `Delegation ${toolName} must resolve a handler with permissions`,
      );
    }
    for (const role of registeredRoles) {
      if (
        !hasMemberPermission(
          sessionMemberRole(role),
          endpoint.config.permissions,
        )
      ) {
        violations.push({ toolName, capability: capability.delegatesTo, role });
      }
    }
  }
  return violations;
};

describe("native chat tool delegation", () => {
  test("classifies every native internal and mutation policy", () => {
    const nativeCandidates = Object.entries(BUILT_IN_CHAT_TOOL_POLICY_KINDS)
      .filter(
        ([name, kind]) =>
          !Object.hasOwn(MCP_CHAT_TOOL_POLICY_KINDS, name) &&
          (kind === "internal" || kind === "mutation"),
      )
      .map(([name]) => name);
    expect(Object.keys(NATIVE_CHAT_TOOL_DELEGATIONS).toSorted()).toEqual(
      nativeCandidates.toSorted(),
    );
    for (const declaration of Object.values(NATIVE_CHAT_TOOL_DELEGATIONS)) {
      if (declaration.type === "waiver") {
        expect(declaration.reason.trim().length).toBeGreaterThan(0);
      }
      if (declaration.type === "execution-mode") {
        expect(declaration.client.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("registered roles satisfy each delegated handler's live permissions", async () => {
    const registrations: InspectDelegatedRegistrationsOptions["registrations"][number][] =
      [];
    for (const role of memberRoles) {
      for (const scope of ["matter", "global"] as const) {
        for (const file of ["present", "absent"] as const) {
          for (const client of ["present", "absent"] as const) {
            for (const skill of ["present", "absent"] as const) {
              for (const editApplyMode of ["manual", "auto"] as const) {
                const props = registrationProps(role);
                registrations.push({
                  role,
                  tools: getChatTools({
                    ...props,
                    editApplyMode,
                    workspaceId: scope === "matter" ? workspaceId : null,
                    requestWorkspaceId: scope === "matter" ? workspaceId : null,
                    activeFile:
                      file === "present" ? props.activeFile : undefined,
                    hasActiveDocxEditClient: client === "present",
                    hasActiveDocxFileClient: client === "present",
                    activeSkillContext:
                      skill === "present" ? props.activeSkillContext : null,
                  }),
                });
              }
            }
          }
        }
      }
    }
    expect(
      await inspectDelegatedRegistrations({
        declarations: NATIVE_CHAT_TOOL_DELEGATIONS,
        registrations,
      }),
    ).toEqual([]);
  });

  test("reports a registration outside the delegated handler's role authority", async () => {
    const declarations = {
      "sample-writer": NATIVE_CHAT_TOOL_DELEGATIONS.suggest_changes.server,
    } as const;
    // The inspector reads registered names only.
    const tools = asTestRaw<ChatToolMap>({
      "sample-writer": { name: "sample-writer" },
    });
    expect(
      await inspectDelegatedRegistrations({
        declarations,
        registrations: [{ role: "intern", tools }],
      }),
    ).toEqual([
      {
        toolName: "sample-writer",
        capability: declarations["sample-writer"].delegatesTo,
        role: "intern",
      },
    ]);
    expect(
      await inspectDelegatedRegistrations({
        declarations,
        registrations: [{ role: "owner", tools }],
      }),
    ).toEqual([]);
  });
});
