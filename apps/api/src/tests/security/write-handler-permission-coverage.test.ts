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
 * mutate organization data or meter AI on the baseline grant unobserved — and
 * every entry in the debt list below is one of those.
 *
 * Two escape routes, deliberately different in kind:
 *  - `// permissions-exempt: <reason>` in the handler file is a REVIEWED
 *    exception (e.g. a purpose-dependent grant checked in-handler rather than
 *    statically). This census reads it from the file's source, not the config
 *    object (comments do not survive to runtime).
 *  - `BASELINE_ON_READ_GRANT` is not a review; it is frozen debt. The
 *    assertion is an equality, so the list can only shrink: a new handler
 *    cannot join it, and an entry that stops offending fails as stale.
 */

const EXEMPT_COMMENT_RE = /\/\/\s*permissions-exempt:/u;

/**
 * Endpoints that already relied on the baseline grant when the census became
 * total. Every one is `mcp: { type: "internal" }`, which is how they escaped
 * both this census and the exporter's affirmation guard. Clearing an entry
 * means either affirming `access: "read"` (a pure read) or giving the handler
 * the resource grant it actually needs — not moving it to the other list.
 */
const BASELINE_ON_READ_GRANT = [
  "agent-auth/confirm.ts",
  "case-law/annotations/create.ts",
  "case-law/annotations/delete.ts",
  "case-law/annotations/list.ts",
  "case-law/annotations/update.ts",
  "desktop-registry/grant.ts",
  "docx-suggestions/read.ts",
  "entities/read-field-file.ts",
  "entities/read-group-counts.ts",
  "entities/read-kanban-group.ts",
  "entities/read-property-facets.ts",
  "external-preview/preview.ts",
  "external-preview/preview.ts#previewExternalFile",
  "files/email-attachment.ts",
  "files/office-citation.ts",
  "files/routes.ts#ocrExportEndpoint",
  "files/routes.ts#readDocumentPropertiesEndpoint",
  "files/routes.ts#scrubbedDownloadEndpoint",
  "mcp-connectors/connect.ts",
  "mcp-connectors/create-connection.ts",
  "mcp-connectors/delete-connection.ts",
  "mcp-connectors/list-connections.ts",
  "mcp-connectors/list-connectors.ts",
  "mcp-connectors/oauth-callback.ts",
  "mcp-connectors/update-connection.ts",
  "saved-searches/create.ts",
  "saved-searches/delete.ts",
  "saved-searches/update.ts",
  "sharepoint/connect.ts",
  "sharepoint/disconnect.ts",
  "sharepoint/list-drive-root.ts",
  "sharepoint/oauth-callback.ts",
  "sharepoint/status.ts",
  "uploads/entity-create-tree.ts",
  "uploads/preflight-entity-create.ts",
  "workspaces/export-overview-activity.ts",
  "workspaces/infosoud-courts.ts",
  "workspaces/infosoud-lookup.ts",
  "workspaces/read-active.ts",
  "workspaces/read-activity.ts",
  "workspaces/read-navigation.ts",
  "workspaces/read-overview-activity-actors.ts",
  "workspaces/read-overview-activity.ts",
  "workspaces/update-active.ts",
].map((suffix) => `apps/api/src/handlers/${suffix}`);

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
    "the handlers on the baseline grant are exactly the frozen debt list",
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

      // Equality, not containment: an addition fails as an unguarded handler,
      // a stale entry fails as debt someone already paid off.
      expect(offenders.toSorted()).toEqual(BASELINE_ON_READ_GRANT.toSorted());
    },
    { timeout: 30_000 },
  );
});
