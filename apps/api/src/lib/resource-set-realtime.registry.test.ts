import { describe, expect, test } from "bun:test";

import { readCapabilityCatalog } from "@stll/cli/capability-catalog-data";

import { parseCatalog } from "@/api/mcp/capability-tools";
import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch";

// Every write capability states what it announces to open tabs (`realtime` on
// its handler config): a resource set, or `noResourceSetUpdates(reason)`. The
// safe-handler wrapper broadcasts the declaration for REST and
// `invoke_capability` alike (see `resource-set-realtime.test.ts` and
// `resource-set-realtime.db.test.ts`), so a declaration is all a handler needs,
// and a new write handler cannot ship without deciding.
//
// Write capabilities that predate the declaration and have not been classified
// yet. This list only shrinks: a capability that gains a declaration must
// leave it (the stale-entry test below), and nothing new may join it (the
// `unclassified-realtime-write-capabilities` metric in scripts/ratchet.ts
// fails `ratchet --check` when the list grows against the merge base).
const UNCLASSIFIED_WRITE_CAPABILITIES: readonly string[] = [
  "case-law.analysis.generate",
  "case-law.matter-links.batch.create",
  "case-law.matter-links.create",
  "case-law.matter-links.delete",
  "chat.export.create",
  "chat.fork.create",
  "chat.threads.delete",
  "chat.threads.rename",
  "chat.threads.update",
  "clauses.categories.create",
  "clauses.categories.delete",
  "clauses.categories.update",
  "clauses.create",
  "clauses.delete",
  "clauses.import",
  "clauses.rewrite",
  "clauses.update",
  "clauses.variants.create",
  "clauses.variants.delete",
  "clauses.variants.update",
  "clauses.versions.restore",
  "clauses.versions.summarize",
  "contacts.create",
  "contacts.delete",
  "contacts.import",
  "contacts.update",
  "document-translations.runs.create",
  "document-types.create",
  "document-types.delete",
  "document-types.reorder",
  "document-types.update",
  "entities.ocr.create",
  "entities.placements.suggest",
  "entities.versions.delete",
  "entities.versions.restore",
  "entities.versions.summarize",
  "entity-views.create",
  "entity-views.delete",
  "entity-views.reorder",
  "entity-views.update",
  "flows.create",
  "flows.delete",
  "flows.update",
  "legal-reader.annotations.create",
  "legal-reader.annotations.delete",
  "legal-reader.annotations.update",
  "lists.verifications.claim-reviews.bulk.create",
  "lists.verifications.claim-reviews.create",
  "lists.verifications.create",
  "matters.cells.retry",
  "matters.correspondence.update",
  "matters.workflow.start",
  "number-series.archive",
  "number-series.create",
  "number-series.default.update",
  "number-series.update",
  "organization-settings.anonymization-blacklist.update",
  "organization-settings.correspondence.allowed-senders.create",
  "organization-settings.correspondence.allowed-senders.delete",
  "organization-settings.correspondence.allowed-senders.list",
  "organization-settings.correspondence.allowed-senders.scope.add",
  "organization-settings.correspondence.allowed-senders.scope.remove",
  "organization-settings.practice-jurisdictions.update",
  "organization-settings.update",
  "playbooks.approve",
  "playbooks.create",
  "playbooks.delete",
  "playbooks.from-run.create",
  "playbooks.from-starter.create",
  "playbooks.update",
  "playbooks.versions.restore",
  "properties.preview",
  "properties.prompt.suggest",
  "reports.builtins.clone",
  "reports.exports.get",
  "reports.views.export",
  "saved-time-narratives.create",
  "saved-time-narratives.delete",
  "saved-time-narratives.update",
  "seller-profiles.archive",
  "seller-profiles.create",
  "seller-profiles.default.update",
  "seller-profiles.update",
  "signals.acceptances.create",
  "signals.assignments.create",
  "signals.dismissals.create",
  "signals.requests.create",
  "signals.snoozes.create",
  "skills.discover",
  "skills.drafts.generate",
  "skills.resources.rewrite",
  "style-sets.create",
  "style-sets.delete",
  "style-sets.from-editor.create",
  "style-sets.from-editor.update",
  "style-sets.replace",
  "style-sets.update",
  "template-packs.installs.create",
  "template-packs.visibility.update",
  "template-recipes.create",
  "template-recipes.delete",
  "templates.blank.create",
  "templates.categories.create",
  "templates.categories.delete",
  "templates.categories.update",
  "templates.clause-slots.update",
  "templates.clauses.link",
  "templates.clauses.sync",
  "templates.clauses.unlink",
  "templates.create",
  "templates.delete",
  "templates.document.update",
  "templates.fields.suggest",
  "templates.fill",
  "templates.fills.create",
  "templates.fills.download",
  "templates.from-style-set.create",
  "templates.from-styles.create",
  "templates.lookup-formats.create",
  "templates.lookup-formats.default.update",
  "templates.lookup-formats.delete",
  "templates.lookup-formats.my-default.update",
  "templates.outdated-clauses.sync",
  "templates.prefill",
  "templates.prepare",
  "templates.update",
  "templates.versions.summarize",
  "time-entries.approval-queue.approve",
  "time-entries.approval-queue.return",
  "time-entries.internal.create",
  "time-entries.me.daily-target.update",
  "time-entries.members.daily-target.update",
  "time-timers.admin.stop",
  "time-timers.confirm",
  "time-timers.discard",
  "time-timers.pause",
  "time-timers.resume",
  "time-timers.start",
  "time-timers.update",
  "uploads.create",
  "uploads.delete",
  "vat-rates.archive",
  "vat-rates.create",
  "vat-rates.update",
  "view-templates.create",
  "view-templates.delete",
  "views.convert",
  "views.create",
  "views.delete",
  "views.reorder",
  "views.update",
];

type Declaration = { scope?: unknown; reason?: unknown } | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const loadDeclaration = async (id: string): Promise<Declaration | null> => {
  const dispatch:
    | { load: () => Promise<Record<string, unknown>>; exportName?: string }
    | undefined = Reflect.get(CAPABILITY_DISPATCH, id);
  if (dispatch === undefined) {
    return null;
  }
  const loaded = await dispatch.load();
  const endpoint =
    dispatch.exportName === undefined
      ? loaded["default"]
      : loaded[dispatch.exportName];
  if (!isRecord(endpoint) || !isRecord(endpoint["config"])) {
    return null;
  }
  const realtime = endpoint["config"]["realtime"];
  return isRecord(realtime) ? realtime : undefined;
};

const catalog = parseCatalog(readCapabilityCatalog());

const declarations = await Promise.all(
  catalog.map(async (entry) => ({
    entry,
    declaration: await loadDeclaration(entry.id),
  })),
);

describe("realtime declarations on capability handlers", () => {
  test("every capability resolves to a loaded handler config", () => {
    const unresolved = declarations
      .filter(({ declaration }) => declaration === null)
      .map(({ entry }) => entry.id);
    expect(unresolved).toEqual([]);
  });

  test("every write capability declares what it announces", () => {
    const undeclared = declarations
      .filter(
        ({ entry, declaration }) =>
          entry.access === "write" &&
          declaration === undefined &&
          !UNCLASSIFIED_WRITE_CAPABILITIES.includes(entry.id),
      )
      .map(({ entry }) => entry.id);
    expect(undeclared).toEqual([]);
  });

  test("the unclassified list only names undeclared write capabilities", () => {
    const byId = new Map(declarations.map((row) => [row.entry.id, row]));
    const stale = UNCLASSIFIED_WRITE_CAPABILITIES.filter((id) => {
      const row = byId.get(id);
      return row?.entry.access !== "write" || row.declaration !== undefined;
    });
    expect(stale).toEqual([]);
    expect(new Set(UNCLASSIFIED_WRITE_CAPABILITIES).size).toBe(
      UNCLASSIFIED_WRITE_CAPABILITIES.length,
    );
  });

  test("a declaration is one the wrapper can deliver", () => {
    const invalid = declarations.flatMap(({ entry, declaration }) => {
      if (declaration === undefined || declaration === null) {
        return [];
      }
      if (declaration.scope === "none") {
        return typeof declaration.reason === "string" &&
          declaration.reason.trim().length > 0
          ? []
          : [`${entry.id}: "none" needs a reason`];
      }
      // Session, token and public handlers do not run the scoped wrapper, so
      // a declaration on them would never broadcast.
      if (entry.handlerKind !== "workspace" && entry.handlerKind !== "root") {
        return [`${entry.id}: ${entry.handlerKind} handlers cannot announce`];
      }
      if (
        declaration.scope === "workspace" &&
        entry.handlerKind !== "workspace"
      ) {
        return [`${entry.id}: a matter-scoped set needs a matter handler`];
      }
      return declaration.scope === "workspace" ||
        declaration.scope === "organization"
        ? []
        : [`${entry.id}: unknown scope`];
    });
    expect(invalid).toEqual([]);
  });
});
