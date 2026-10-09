import { describe, expect, test } from "bun:test";

import {
  RECENT_FILES_STORAGE_KEY,
  ownerStorageKey,
} from "@stll/api-contract/browser-storage";
import type { RecentFile } from "@stll/api-contract/browser-storage";
import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";

import { seedRecentFilesStorageState } from "./seed-recents";

const origin = "http://localhost:3100";
const userId = "seed-user";
const organizationId = "seed-org";
const recentKey = ownerStorageKey(
  `${RECENT_FILES_STORAGE_KEY}:${organizationId}:`,
  { kind: "user", userId },
);
const files = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  EML_MIME_TYPE,
].map((mimeType, index) => ({
  entityId: `seed-entity-${index}`,
  workspaceId: "seed-matter",
  workspaceName: "Seed matter",
  title: `Seed file ${index}`,
  fileFieldId: `seed-field-${index}`,
  filePropertyId: "seed-file-property",
  mimeType,
  openedAt: "2025-01-01T00:00:00.000Z",
})) satisfies RecentFile[];

describe("seeded browser recent files", () => {
  test("contains each seeded file kind without replacing authentication or unrelated storage", () => {
    const state = {
      cookies: [{ name: "session", value: "seed-session" }],
      origins: [
        {
          origin: "http://localhost:3101",
          localStorage: [{ name: "other", value: "kept" }],
        },
        { origin, localStorage: [{ name: "theme", value: "light" }] },
      ],
    };
    const seeded = seedRecentFilesStorageState({
      state,
      origin,
      organizationId,
      userId,
      files,
    });
    expect(seeded.cookies).toEqual(state.cookies);
    expect(
      seeded.origins.find((entry) => entry.origin === "http://localhost:3101"),
    ).toEqual(state.origins.at(0));
    const localStorage = seeded.origins.find(
      (entry) => entry.origin === origin,
    )?.localStorage;
    expect(localStorage).toContainEqual({ name: "theme", value: "light" });
    expect(localStorage).toContainEqual({
      name: recentKey,
      value: JSON.stringify(files),
    });
  });

  test("repeated seeding is stable across document completion order", () => {
    const state = { cookies: [], origins: [] };
    const seeded = seedRecentFilesStorageState({
      state,
      origin,
      organizationId,
      userId,
      files,
    });
    const replayed = seedRecentFilesStorageState({
      state: seeded,
      origin,
      organizationId,
      userId,
      files: files.toReversed(),
    });
    expect(replayed).toEqual(seeded);
    expect(
      replayed.origins
        .flatMap((entry) => entry.localStorage)
        .filter((entry) => entry.name === recentKey),
    ).toHaveLength(1);
  });

  test("missing seeded file kinds fail instead of producing incomplete screenshots", () => {
    expect(() =>
      seedRecentFilesStorageState({
        state: { cookies: [], origins: [] },
        origin,
        organizationId,
        userId,
        files: files.filter((file) => file.mimeType !== EML_MIME_TYPE),
      }),
    ).toThrow(`No seeded recent file for ${EML_MIME_TYPE}`);
  });
});
