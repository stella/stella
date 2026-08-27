import { describe, expect, test } from "bun:test";

import {
  discoverSafeHandlers,
  isRecord,
} from "../../../scripts/lib/enumerate-safe-handlers";

/**
 * A handler that mutates (`access: "write"`) or spends AI budget
 * (`requiresUsage.actionType === "chat"`) must be gated by more than the
 * baseline `workspace:["read"]` grant every member (down to the lowest-
 * privileged "external" role) already holds. `workspace:["read"]` alone is
 * the shape of a pure read; pairing it with a mutating or AI-consuming
 * capability lets a member with no resource-level grant reach a write or
 * spend AI quota anyway.
 *
 * Escape hatch: a handler config may carry a `// permissions-exempt: <reason>`
 * comment when a reviewed exception is legitimate. This census reads it from
 * the file's source, not the config object (comments do not survive to
 * runtime).
 */

const EXEMPT_COMMENT_RE = /\/\/\s*permissions-exempt:/u;

const isNonWorkspaceReadOnly = (permissions: unknown): boolean => {
  if (!isRecord(permissions)) {
    return false;
  }
  return Object.entries(permissions).some(([resource, actions]) => {
    if (!Array.isArray(actions) || actions.length === 0) {
      return false;
    }
    if (resource !== "workspace") {
      return true;
    }
    return actions.some((action) => action !== "read");
  });
};

const requiresUsageIsChat = (requiresUsage: unknown): boolean =>
  isRecord(requiresUsage) && requiresUsage["actionType"] === "chat";

describe("write/AI-consuming handlers carry a grant beyond workspace:read", () => {
  test(
    "every access:write or chat-metered handler has a non-workspace-read-only permission, or an exemption comment",
    async () => {
      const { endpoints, files, importErrors } = await discoverSafeHandlers();

      // An unimportable module is an unmeasured handler; the census only
      // means something if every handler it claims to cover actually loaded.
      expect(importErrors).toEqual([]);

      const sourceByFile = new Map(files.map((file) => [file.id, file.source]));

      const offenders: string[] = [];
      for (const endpoint of endpoints) {
        const { config, file, id } = endpoint;
        const permissions = config["permissions"];
        // Session/token/public handlers carry no role-based `permissions`
        // at all; they use a different auth model and are out of scope here.
        if (permissions === undefined) {
          continue;
        }

        const isWrite = config["access"] === "write";
        const isChatMetered = requiresUsageIsChat(config["requiresUsage"]);
        if (!isWrite && !isChatMetered) {
          continue;
        }

        if (isNonWorkspaceReadOnly(permissions)) {
          continue;
        }

        const source = sourceByFile.get(file) ?? "";
        if (EXEMPT_COMMENT_RE.test(source)) {
          continue;
        }

        const requiresUsage = config["requiresUsage"];
        const actionType = isRecord(requiresUsage)
          ? String(requiresUsage["actionType"])
          : "none";
        offenders.push(
          `${id} (access=${String(config["access"])}, requiresUsage.actionType=${actionType})`,
        );
      }

      expect(offenders).toEqual([]);
    },
    { timeout: 30_000 },
  );
});
