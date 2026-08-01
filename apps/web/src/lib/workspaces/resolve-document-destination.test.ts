import { describe, expect, test } from "bun:test";

import { resolveCanonicalDocumentDestination } from "./resolve-document-destination";

const workspaceId = "workspace";
const entityId = "entity";

const loadCurrentFields =
  (
    fields: {
      id: string;
      content: { type: string };
    }[],
  ) =>
  async () =>
    fields;

describe("canonical document destination resolution", () => {
  test("keeps a complete API destination without reading the entity", async () => {
    const loadForbidden = async () => {
      throw new Error("entity query must stay lazy");
    };

    expect(
      await resolveCanonicalDocumentDestination({
        entityId,
        fieldId: "field",
        loadCurrentFields: loadForbidden,
        workspaceId,
      }),
    ).toEqual({ entityId, fieldId: "field" });
  });

  test("resolves an omitted additive field from the authorized current entity", async () => {
    expect(
      await resolveCanonicalDocumentDestination({
        entityId,
        fieldId: undefined,
        loadCurrentFields: loadCurrentFields([
          { id: "text-field", content: { type: "text" } },
          { id: "file-field", content: { type: "file" } },
        ]),
        workspaceId,
      }),
    ).toEqual({ entityId, fieldId: "file-field" });
  });

  test("never manufactures a partial destination", async () => {
    const unknownIds = [undefined, null, false, 0, {}, []];
    const loadNoFields = loadCurrentFields([]);

    expect(
      await Promise.all(
        unknownIds.map(async (unknownId) => {
          const destination = await resolveCanonicalDocumentDestination({
            entityId: unknownId,
            fieldId: unknownId,
            loadCurrentFields: loadNoFields,
            workspaceId,
          });
          return destination;
        }),
      ),
    ).toEqual(unknownIds.map(() => null));
    expect(
      await resolveCanonicalDocumentDestination({
        entityId,
        fieldId: undefined,
        loadCurrentFields: loadNoFields,
        workspaceId,
      }),
    ).toBeNull();
  });
});
