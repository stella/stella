import { panic } from "better-result";
import * as v from "valibot";

// Submits a stable extension package to the Chrome Web Store for review
// (Chrome Web Store API V2). The release workflow runs it once the GitHub
// release is published; every step is safe to rerun.
//
// Usage: bun apps/extension/scripts/publish-store.ts <version> <zip>
// CHROME_WEB_STORE_ACCESS_TOKEN holds a token with the chromewebstore scope.

const PUBLISHER_ID = "0e171b20-26b4-4f46-89c9-ffcebaf95982";
const ITEM_ID = "hdjfdkknlahegaifklbelmafmpooakmi";
const API_ORIGIN = "https://chromewebstore.googleapis.com";
const ITEM_NAME = `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`;

const UPLOAD_POLL_ATTEMPTS = 30;
const UPLOAD_POLL_INTERVAL_MS = 10_000;
const CHROME_VERSION_COMPONENT_MAX = 65_535;
const CHROME_VERSION_COMPONENT_COUNT = 4;

const itemStateSchema = v.picklist([
  "ITEM_STATE_UNSPECIFIED",
  "PENDING_REVIEW",
  "STAGED",
  "PUBLISHED",
  "PUBLISHED_TO_TESTERS",
  "REJECTED",
  "CANCELLED",
]);

// The reference lists IN_PROGRESS while the upload guide names
// UPLOAD_IN_PROGRESS; both mean the package is still being processed.
const uploadStateSchema = v.picklist([
  "UPLOAD_STATE_UNSPECIFIED",
  "SUCCEEDED",
  "IN_PROGRESS",
  "UPLOAD_IN_PROGRESS",
  "FAILED",
  "NOT_FOUND",
]);
type UploadState = v.InferOutput<typeof uploadStateSchema>;

const revisionStatusSchema = v.object({
  distributionChannels: v.optional(
    v.array(v.object({ crxVersion: v.optional(v.string()) })),
    [],
  ),
  state: itemStateSchema,
});
type RevisionStatus = v.InferOutput<typeof revisionStatusSchema>;

const statusSchema = v.object({
  lastAsyncUploadState: v.optional(uploadStateSchema),
  publishedItemRevisionStatus: v.optional(revisionStatusSchema),
  submittedItemRevisionStatus: v.optional(revisionStatusSchema),
  takenDown: v.optional(v.boolean(), false),
});

const uploadSchema = v.object({
  crxVersion: v.optional(v.string()),
  uploadState: uploadStateSchema,
});

const publishSchema = v.object({
  state: itemStateSchema,
  warningInfo: v.optional(
    v.object({
      warnings: v.optional(
        v.array(v.object({ description: v.string(), reason: v.string() })),
        [],
      ),
    }),
  ),
});

// A submission still on its way to users; a rejected or cancelled one is not.
const ACTIVE_SUBMISSION_STATES = new Set(["PENDING_REVIEW", "STAGED"]);
const IN_PROGRESS_UPLOAD_STATES = new Set<UploadState>([
  "IN_PROGRESS",
  "UPLOAD_IN_PROGRESS",
]);

export type StoreOutcome =
  "already-published" | "already-submitted" | "submitted" | "published";

export type StoreClient = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  log: (line: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  token: string;
};

const carriesVersion = (
  revision: RevisionStatus | undefined,
  version: string,
): boolean =>
  revision?.distributionChannels.some(
    ({ crxVersion }) =>
      crxVersion !== undefined &&
      compareChromeVersions(crxVersion, version) === 0,
  ) ?? false;

const chromeVersionParts = (version: string): number[] => {
  if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/u.test(version)) {
    panic(`Invalid Chrome Web Store version: ${version}`);
  }
  const parts = version.split(".").map(Number);
  if (
    parts.some((part) => part > CHROME_VERSION_COMPONENT_MAX) ||
    parts.every((part) => part === 0)
  ) {
    panic(`Invalid Chrome Web Store version: ${version}`);
  }
  return parts;
};

const compareChromeVersions = (left: string, right: string): number => {
  const existing = chromeVersionParts(left);
  const requested = chromeVersionParts(right);
  for (let index = 0; index < CHROME_VERSION_COMPONENT_COUNT; index += 1) {
    const difference = (existing.at(index) ?? 0) - (requested.at(index) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const assertNoNewerRevision = (revision: RevisionStatus, version: string) => {
  if (revision.distributionChannels.length === 0) {
    panic("Chrome Web Store revision has no version; refusing to replace it");
  }
  for (const { crxVersion } of revision.distributionChannels) {
    if (crxVersion === undefined) {
      panic("Chrome Web Store revision has no version; refusing to replace it");
    }
    if (compareChromeVersions(crxVersion, version) > 0) {
      panic(
        `Refusing to replace newer Chrome Web Store version ${crxVersion} with ${version}`,
      );
    }
  }
};

type StoreRequest = {
  body?: BodyInit;
  contentType?: string;
  method: "GET" | "POST";
  path: string;
};

const call = async <TSchema extends v.GenericSchema>(
  client: StoreClient,
  schema: TSchema,
  { body, contentType, method, path }: StoreRequest,
): Promise<v.InferOutput<TSchema>> => {
  const response = await client.fetch(`${API_ORIGIN}${path}`, {
    body: body ?? null,
    headers: {
      authorization: `Bearer ${client.token}`,
      ...(contentType === undefined ? {} : { "content-type": contentType }),
    },
    method,
  });
  const text = await response.text();
  if (!response.ok) {
    panic(
      `Chrome Web Store ${method} ${path} failed with ${String(response.status)}: ${text.slice(0, 500)}`,
    );
  }
  const parsed = v.safeParse(schema, text === "" ? {} : JSON.parse(text));
  if (!parsed.success) {
    panic(
      `Chrome Web Store ${method} ${path} returned an unexpected response: ${text.slice(0, 500)}`,
    );
  }
  return parsed.output;
};

const fetchStatus = async (client: StoreClient) =>
  await call(client, statusSchema, {
    method: "GET",
    path: `/v2/${ITEM_NAME}:fetchStatus`,
  });

const awaitUpload = async (client: StoreClient): Promise<void> => {
  for (let attempt = 0; attempt < UPLOAD_POLL_ATTEMPTS; attempt += 1) {
    await client.sleep(UPLOAD_POLL_INTERVAL_MS);
    const state = (await fetchStatus(client)).lastAsyncUploadState;
    if (state === "SUCCEEDED") {
      return;
    }
    if (state === undefined || !IN_PROGRESS_UPLOAD_STATES.has(state)) {
      panic(`Chrome Web Store upload ended in state ${state ?? "unset"}`);
    }
  }
  panic("Chrome Web Store upload did not finish in time");
};

export const publishToStore = async (
  client: StoreClient,
  version: string,
  zip: Blob,
): Promise<StoreOutcome> => {
  chromeVersionParts(version);
  const status = await fetchStatus(client);
  if (status.takenDown) {
    panic("The Chrome Web Store item is taken down; publish it manually");
  }
  if (carriesVersion(status.publishedItemRevisionStatus, version)) {
    client.log(`Version ${version} is already published.`);
    return "already-published";
  }
  if (status.publishedItemRevisionStatus !== undefined) {
    assertNoNewerRevision(status.publishedItemRevisionStatus, version);
  }
  const submitted = status.submittedItemRevisionStatus;
  if (
    submitted !== undefined &&
    ACTIVE_SUBMISSION_STATES.has(submitted.state)
  ) {
    if (carriesVersion(submitted, version)) {
      client.log(
        `Version ${version} is already submitted (${submitted.state}).`,
      );
      return "already-submitted";
    }
    assertNoNewerRevision(submitted, version);
    // The latest release replaces an older one still in review.
    client.log(`Cancelling the older submission (${submitted.state}).`);
    await call(client, v.object({}), {
      method: "POST",
      path: `/v2/${ITEM_NAME}:cancelSubmission`,
    });
  }

  const upload = await call(client, uploadSchema, {
    body: zip,
    contentType: "application/zip",
    method: "POST",
    path: `/upload/v2/${ITEM_NAME}:upload`,
  });
  if (IN_PROGRESS_UPLOAD_STATES.has(upload.uploadState)) {
    await awaitUpload(client);
  } else if (upload.uploadState !== "SUCCEEDED") {
    panic(`Chrome Web Store upload ended in state ${upload.uploadState}`);
  } else if (upload.crxVersion !== version) {
    panic(
      `Chrome Web Store accepted version ${upload.crxVersion ?? "unset"}, expected ${version}`,
    );
  }

  const published = await call(client, publishSchema, {
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }),
    contentType: "application/json",
    method: "POST",
    path: `/v2/${ITEM_NAME}:publish`,
  });
  for (const { description, reason } of published.warningInfo?.warnings ?? []) {
    client.log(`Warning ${reason}: ${description}`);
  }
  if (published.state === "PENDING_REVIEW" || published.state === "STAGED") {
    client.log(`Version ${version} is submitted for review.`);
    return "submitted";
  }
  if (published.state === "PUBLISHED") {
    client.log(`Version ${version} is published.`);
    return "published";
  }
  return panic(`Chrome Web Store publish ended in state ${published.state}`);
};

if (import.meta.main) {
  const [version, zipPath] = process.argv.slice(2);
  if (version === undefined || !/^\d+\.\d+\.\d+$/u.test(version)) {
    panic("Usage: publish-store.ts <stable version> <zip>");
  }
  if (zipPath === undefined) {
    panic("Usage: publish-store.ts <stable version> <zip>");
  }
  const token =
    process.env["CHROME_WEB_STORE_ACCESS_TOKEN"] ??
    panic("CHROME_WEB_STORE_ACCESS_TOKEN is required");
  await publishToStore(
    {
      fetch: async (url, init) => await fetch(url, init),
      log: (line) => console.log(line),
      sleep: async (milliseconds) => await Bun.sleep(milliseconds),
      token,
    },
    version,
    Bun.file(zipPath),
  );
}
