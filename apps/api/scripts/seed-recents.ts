import { panic } from "better-result";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import * as v from "valibot";

import {
  RECENT_FILES_STORAGE_KEY,
  ownerStorageKey,
} from "@stll/api-contract/browser-storage";
import type { RecentFile } from "@stll/api-contract/browser-storage";
import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import { compareCodeUnit } from "@stll/collation";

const StorageStateSchema = v.object({
  cookies: v.array(v.unknown()),
  origins: v.array(
    v.object({
      origin: v.string(),
      localStorage: v.array(v.object({ name: v.string(), value: v.string() })),
    }),
  ),
});

type SeedRecentsOptions = {
  state: v.InferOutput<typeof StorageStateSchema>;
  origin: string;
  organizationId: string;
  userId: string;
  files: readonly RecentFile[];
};

export const seedRecentFilesStorageState = ({
  state,
  origin,
  organizationId,
  userId,
  files,
}: SeedRecentsOptions) => {
  const mimeTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    EML_MIME_TYPE,
  ];
  const orderedFiles = files.toSorted((a, b) =>
    compareCodeUnit(a.entityId, b.entityId),
  );
  const recentFiles = mimeTypes.map((mimeType) => {
    const file = orderedFiles.find(
      (candidate) => candidate.mimeType === mimeType,
    );
    if (!file) {
      return panic(`No seeded recent file for ${mimeType}`);
    }
    return file;
  });
  const name = ownerStorageKey(
    `${RECENT_FILES_STORAGE_KEY}:${organizationId}:`,
    { kind: "user", userId },
  );
  const existingOrigin = state.origins.find(
    (candidate) => candidate.origin === origin,
  );
  const seededOrigin = {
    origin,
    localStorage: [
      ...(existingOrigin?.localStorage.filter((entry) => entry.name !== name) ??
        []),
      { name, value: JSON.stringify(recentFiles) },
    ],
  };
  return {
    cookies: state.cookies,
    origins: [
      ...state.origins.filter((candidate) => candidate.origin !== origin),
      seededOrigin,
    ],
  };
};

type WriteSeedRecentsOptions = Omit<SeedRecentsOptions, "state"> & {
  path: string;
};

export const writeSeedRecentFiles = ({
  path,
  ...options
}: WriteSeedRecentsOptions) => {
  const state = v.parse(
    StorageStateSchema,
    JSON.parse(readFileSync(path, "utf-8")),
  );
  writeFileSync(
    path,
    JSON.stringify(seedRecentFilesStorageState({ state, ...options }), null, 2),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
};
