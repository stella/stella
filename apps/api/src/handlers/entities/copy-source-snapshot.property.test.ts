import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";

import { sourceSnapshotsMatch } from "./copy-utils";
import type { EntitySnapshot, EntityVersionSnapshot } from "./copy-utils";

const snapshots = fc
  .array(
    fc.record({
      name: fc.string(),
      readOnly: fc.boolean(),
      label: fc.option(fc.string(), { nil: null }),
      description: fc.option(fc.string(), { nil: null }),
      value: fc.string(),
      createdAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    }),
    { minLength: 1, maxLength: 5 },
  )
  .map((rows) =>
    rows.map(
      ({ name, readOnly, label, description, value, createdAt }, index) => {
        const id = toSafeId<"entity">(`entity_${String(index)}`);
        const versions = [1, 2].map((versionNumber) => ({
          id: toSafeId<"entityVersion">(`${id}_v${String(versionNumber)}`),
          versionNumber,
          stamp: null,
          label,
          description,
          diffWordsAdded: null,
          diffWordsRemoved: null,
          createdBy: null,
          source: null,
          collaborationContributorUserIds: null,
          detectedLanguage: null,
          createdAt: new Date(createdAt),
          fields: [1, 2].map((fieldNumber) => ({
            id: toSafeId<"field">(
              `${id}_v${String(versionNumber)}_f${String(fieldNumber)}`,
            ),
            propertyId: toSafeId<"property">(`property_${String(fieldNumber)}`),
            content: { type: "text", version: 1, value } as const,
          })),
        }));
        return {
          id,
          kind: "document",
          name,
          readOnly,
          parentId: null,
          currentVersionId: versions.at(-1)?.id ?? null,
          versions,
        } satisfies EntitySnapshot;
      },
    ),
  );

test("entity-transfer.snapshot-order-invariance", () => {
  assertProperty(
    "entity-transfer.snapshot-order-invariance",
    fc.property(snapshots, (source) => {
      const reordered = structuredClone(source).toReversed();
      for (const entity of reordered) {
        entity.versions = entity.versions.toReversed();
        for (const version of entity.versions) {
          version.fields = version.fields.toReversed();
        }
      }
      expect(sourceSnapshotsMatch(source, reordered)).toBe(true);
      expect(sourceSnapshotsMatch(reordered, source)).toBe(true);
    }),
  );
});

test("entity-transfer.carried-state-invariance", () => {
  assertProperty(
    "entity-transfer.carried-state-invariance",
    fc.property(snapshots, (source) => {
      for (const entity of source) {
        const entityEdits = {
          id: { id: toSafeId<"entity">(`${entity.id}_changed`) },
          kind: { kind: "folder" },
          name: { name: `${entity.name} changed` },
          parentId: { parentId: toSafeId<"entity">("another_parent") },
          readOnly: { readOnly: !entity.readOnly },
          currentVersionId: { currentVersionId: null },
          versions: { versions: [] },
        } satisfies {
          [Key in keyof EntitySnapshot]-?: Pick<EntitySnapshot, Key>;
        };
        for (const edit of Object.values(entityEdits)) {
          const changed = source.map((row) =>
            row.id === entity.id ? { ...row, ...edit } : row,
          );
          expect(sourceSnapshotsMatch(source, changed)).toBe(false);
        }
        for (const version of entity.versions) {
          const versionEdits = {
            id: { id: toSafeId<"entityVersion">(`${version.id}_changed`) },
            label: { label: `${version.label ?? ""} changed` },
            description: {
              description: `${version.description ?? ""} changed`,
            },
            createdAt: { createdAt: new Date(version.createdAt.getTime() + 1) },
            versionNumber: { versionNumber: version.versionNumber + 1 },
            stamp: { stamp: "2026/001/001.v1" },
            diffWordsAdded: { diffWordsAdded: 1 },
            diffWordsRemoved: { diffWordsRemoved: 1 },
            createdBy: { createdBy: toSafeId<"user">("changed_author") },
            source: { source: { kind: "upload" } },
            collaborationContributorUserIds: {
              collaborationContributorUserIds: [
                toSafeId<"user">("contributor"),
              ],
            },
            detectedLanguage: { detectedLanguage: "CS" },
            fields: { fields: [] },
          } satisfies {
            [Key in keyof EntityVersionSnapshot]: Pick<
              EntityVersionSnapshot,
              Key
            >;
          };
          for (const edit of Object.values(versionEdits)) {
            const changedVersions = source.map((row) => ({
              ...row,
              versions: row.versions.map((carried) =>
                carried.id === version.id ? { ...carried, ...edit } : carried,
              ),
            }));
            expect(sourceSnapshotsMatch(source, changedVersions)).toBe(false);
          }
          const changedFields = source.map((row) => ({
            ...row,
            versions: row.versions.map((carried) => ({
              ...carried,
              fields: carried.fields.map((field) => ({
                ...field,
                content:
                  carried.id === version.id
                    ? {
                        ...field.content,
                        value: `${field.content.value} changed`,
                      }
                    : field.content,
              })),
            })),
          }));
          expect(sourceSnapshotsMatch(source, changedFields)).toBe(false);
        }
        expect(
          sourceSnapshotsMatch(
            source,
            source.filter(({ id }) => id !== entity.id),
          ),
        ).toBe(false);
      }
    }),
  );
});
