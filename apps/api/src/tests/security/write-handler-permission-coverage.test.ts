import { describe, expect, test } from "bun:test";

import {
  discoverSafeHandlers,
  isRecord,
} from "../../../scripts/lib/enumerate-safe-handlers";

/**
 * A handler that is not an affirmed pure read, or that spends AI budget under
 * ANY meter, must be gated by more than the baseline `workspace:["read"]`
 * grant every member (down to the lowest-privileged "external" role) already
 * holds. `workspace:["read"]` alone is the shape of a pure read; pairing it
 * with a mutating or AI-consuming capability lets a member with no
 * resource-level grant reach a write or spend AI quota anyway.
 *
 * The read side is an AFFIRMATION, not an inference, and it is the same
 * affirmation the capability exporter demands: `access: "read"` is the only
 * way out of this census, so a mutating handler cannot escape by declaring
 * nothing. That is what makes the census total over the handler graph. The
 * hole it closes was precise: the exporter's affirmation guard runs only on
 * exported capabilities, so every `mcp: { type: "internal" }` handler could
 * mutate organization data or meter AI on the baseline grant unobserved.
 *
 * The one escape route is `// permissions-exempt: <reason>` in the handler
 * file: a REVIEWED exception (e.g. a write that reaches nothing but the
 * caller's own row). This census reads it from the file's source, not the
 * config object (comments do not survive to runtime).
 */

const EXEMPT_COMMENT_RE = /\/\/\s*permissions-exempt:/u;

/** A grant that reaches past `workspace:["read"]`, the grant everyone holds. */
const carriesExplicitPermission = (permissions: unknown): boolean => {
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

/**
 * Whether a config must name a resource grant: anything that did not affirm
 * itself a pure read, plus every AI-metered handler regardless of meter (an
 * affirmed read that spends `case_law` or `chat` budget still spends it).
 */
const requiresExplicitPermission = (config: Record<string, unknown>): boolean =>
  config["access"] !== "read" || isRecord(config["requiresUsage"]);

describe("the census rule", () => {
  test("a metered handler is covered whatever its meter, and however it reads", () => {
    for (const actionType of ["chat", "case_law", "document_processing"]) {
      expect(
        requiresExplicitPermission({
          access: "read",
          requiresUsage: { actionType },
        }),
      ).toBe(true);
    }
  });

  test("only an affirmed, unmetered read leaves the census", () => {
    expect(requiresExplicitPermission({ access: "read" })).toBe(false);
    expect(requiresExplicitPermission({ access: "write" })).toBe(true);
    // Declaring nothing is a write by inference, exactly as the capability
    // exporter reads it; silence must not be an exit.
    expect(requiresExplicitPermission({})).toBe(true);
  });

  test("the baseline grant is not an explicit permission; any resource grant is", () => {
    expect(carriesExplicitPermission({ workspace: ["read"] })).toBe(false);
    expect(carriesExplicitPermission({ workspace: [] })).toBe(false);
    expect(carriesExplicitPermission({ caseLawResearch: [] })).toBe(false);
    expect(carriesExplicitPermission({ workspace: ["read", "update"] })).toBe(
      true,
    );
    expect(carriesExplicitPermission({ caseLawResearch: ["run"] })).toBe(true);
  });

  test("an AI-metered handler on the baseline grant is an offender", () => {
    const permissions = { workspace: ["read"] };
    const config = { permissions, requiresUsage: { actionType: "chat" } };

    expect(
      requiresExplicitPermission(config) &&
        !carriesExplicitPermission(permissions),
    ).toBe(true);
  });
});

describe("write/AI-consuming handlers carry a grant beyond workspace:read", () => {
  test(
    "no handler writes or meters AI on the baseline grant",
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
        if (!requiresExplicitPermission(config)) {
          continue;
        }
        if (carriesExplicitPermission(permissions)) {
          continue;
        }
        if (EXEMPT_COMMENT_RE.test(sourceByFile.get(file) ?? "")) {
          continue;
        }
        offenders.push(id);
      }

      expect(offenders.toSorted()).toEqual([]);
    },
    { timeout: 30_000 },
  );
});
