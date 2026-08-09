// Passive regression fixture for
// no-unowned-file-version-write/no-unowned-file-version-write.

import {
  entities as entityTable,
  entityVersions as versionTable,
} from "@/api/db/schema";
import {
  // oxlint-disable-next-line no-unowned-file-version-write/no-unowned-file-version-write -- fixture: field cloning outside a reviewed owner must be rejected
  cloneFieldsForRevision as cloneRevisionFields,
  // oxlint-disable-next-line no-unowned-file-version-write/no-unowned-file-version-write -- fixture: version numbering outside a reviewed owner must be rejected
  nextEntityVersionNumber,
} from "@/api/lib/entity-versions/version-utils";

import * as relativeSchema from "../../apps/api/src/db/schema.ts";
import * as relativeVersionUtils from "../../apps/api/src/lib/entity-versions/version-utils.ts";

declare const directTx: {
  insert: (table: unknown) => unknown;
  update: (table: unknown) => {
    set: (values: unknown) => unknown;
  };
};

// oxlint-disable-next-line no-unowned-file-version-write/no-unowned-file-version-write -- fixture: direct version rows outside a reviewed owner must be rejected
void directTx.insert(versionTable);
// oxlint-disable-next-line no-unowned-file-version-write/no-unowned-file-version-write -- fixture: direct current-version transitions outside a reviewed owner must be rejected
void directTx.update(entityTable).set({ currentVersionId: "version-id" });

const locallyAliasedVersionTable = relativeSchema.entityVersions;
// oxlint-disable-next-line no-unowned-file-version-write/no-unowned-file-version-write -- fixture: relative namespace imports and local table aliases must not evade the guard
void directTx.insert(locallyAliasedVersionTable);
// oxlint-disable-next-line no-unowned-file-version-write/no-unowned-file-version-write -- fixture: relative namespace imports must not evade current-version detection
void directTx
  .update(relativeSchema.entities)
  .set({ currentVersionId: "version-id" });

declare const tx: Parameters<typeof nextEntityVersionNumber>[0];
declare const entityId: Parameters<
  typeof nextEntityVersionNumber
>[1]["entityId"];
declare const workspaceId: Parameters<
  typeof nextEntityVersionNumber
>[1]["workspaceId"];

await nextEntityVersionNumber(tx, { entityId, workspaceId });
// oxlint-disable-next-line no-unowned-file-version-write/no-unowned-file-version-write -- fixture: relative namespace helper imports must not evade the guard
await relativeVersionUtils.nextEntityVersionNumber(tx, {
  entityId,
  workspaceId,
});
void cloneRevisionFields;
