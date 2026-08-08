/**
 * Seed matters from Harvey LAB (https://github.com/harveyai/harvey-labs), a
 * public corpus of synthetic legal documents, MIT licensed,
 * Copyright (c) 2026 Harvey AI. Fetched at run time into a gitignored cache;
 * nothing is vendored into this repository.
 *
 * Uploads through the real upload path:
 * `entity-create/tree` -> presigned PUT -> finalize. Writing rows and S3 bytes
 * directly would skip the derivative/extraction fan-out, leaving every
 * non-DOCX file without a `pdfFileId` and so unopenable and uncitable.
 *
 * Needs the API, Valkey, MinIO and Gotenberg. Text extraction also needs
 * `bun run document-processing-worker`, which `bun run dev` does not start —
 * without it runs stay `queued` and only filenames are searchable.
 *
 * Processing is queued, so it continues after this exits.
 *
 * Usage: bun run db:seed-firm-knowledge --matters 15 [--api <origin>]
 */

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { sessionCookieNameForDevPort } from "@/api/lib/auth-cookie-name";

const CORPUS_REPOSITORY = "https://github.com/harveyai/harvey-labs.git";
const CORPUS_SUBPATH = "tasks/firm-knowledge/dms/matters";
const CACHE_DIRECTORY = ".cache/firm-knowledge";
const STORAGE_STATE = ".playwright/storage-state.json";
const DEFAULT_API_PORT = 3001;
const DEFAULT_MATTER_COUNT = 15;
const REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 120_000;

/** What the web client names a new matter's file property. */
const FILE_PROPERTY_NAME = "Documents";

/** Better-auth names the session cookie `<prefix>.session_token`. */
const SESSION_COOKIE_SUFFIX = ".session_token";

/** The `invalidateQuery` macro requires a `queryKey` in the body. */
const WORKSPACES_QUERY_KEY = ["workspaces"];
const entitiesQueryKey = (workspaceId: string): string[] => [
  "entities",
  workspaceId,
];

/** Extensions the corpus actually contains, mapped to what the browser sends. */
const MIME_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  eml: "message/rfc822",
};

type TreeDirectory = { key: string; parentKey: string | null; name: string };

type TreeFile = {
  key: string;
  parentKey: string | null;
  name: string;
  mimeType: string;
  size: number;
  sha256Hex: string;
  absolutePath: string;
};

type MatterManifest = {
  directories: TreeDirectory[];
  files: TreeFile[];
  reference: string;
};

/** `headers` are the presigned checksum headers; omitting them fails the signature. */
type SignedFile = {
  headers: Record<string, string>;
  key: string;
  uploadId: string;
  url: string;
};

/** Only the file-kind property can own uploaded documents. */
type WorkspaceProperty = { content: { type: string }; id: string };

/** Also the re-run key. */
const matterName = (reference: string): string => `Matter ${reference}`;

/**
 * The dev runner offsets ports per worktree and persists them nowhere, so scan
 * listening ports instead of recomputing its hash.
 */
const discoverApiOrigin = async (): Promise<string> => {
  // Not `/health`: Gotenberg serves one too. A 401 on a versioned route is ours.
  const isStellaApi = async (port: number): Promise<boolean> => {
    const response = await fetch(
      `http://127.0.0.1:${String(port)}${STELLA_API_VERSION_PREFIX}/workspaces`,
      { signal: AbortSignal.timeout(1500) },
    ).catch(() => null);
    return response !== null && (response.status === 401 || response.ok);
  };

  if (await isStellaApi(DEFAULT_API_PORT)) {
    return `http://127.0.0.1:${String(DEFAULT_API_PORT)}`;
  }

  // lsof is not guaranteed to exist; without it we cannot enumerate ports, so
  // say so rather than dying on a missing executable.
  const listing = ((): string | null => {
    try {
      const result = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]);
      return result.exitCode === 0 ? result.stdout.toString() : null;
    } catch {
      return null;
    }
  })();
  if (listing === null) {
    return fail(
      `No API on port ${String(DEFAULT_API_PORT)} and no way to scan for one. ` +
        "Pass --api http://127.0.0.1:<port>.",
    );
  }

  const ports = [
    ...new Set(
      [...listing.matchAll(/:(?<port>\d{4,5})\s*\(LISTEN\)/gu)]
        .flatMap((match) => {
          const port = Number(match.groups?.["port"]);
          return Number.isInteger(port) ? [port] : [];
        })
        // The runner only ever shifts upward from the defaults.
        .filter(
          (port) => port > DEFAULT_API_PORT && port < DEFAULT_API_PORT + 2000,
        ),
    ),
  ].sort((a, b) => a - b);

  for (const port of ports) {
    // oxlint-disable-next-line no-await-in-loop -- probe in order, stop at the first hit
    if (await isStellaApi(port)) {
      console.log(`Found the dev API on port ${String(port)}.`);
      return `http://127.0.0.1:${String(port)}`;
    }
  }

  return fail(
    "No dev API answered on a versioned route. Start it with 'bun run dev:api', " +
      "or pass --api http://127.0.0.1:<port> explicitly.",
  );
};

// Annotated on the variable, not just the arrow: TypeScript only narrows past
// a never-returning call when the binding itself declares it.
const fail: (message: string) => never = (message) => {
  console.error(message);
  process.exit(1);
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const read = (flag: string): string | null => {
    const index = args.indexOf(flag);
    return index === -1 ? null : (args[index + 1] ?? null);
  };
  const matters = Number(read("--matters") ?? DEFAULT_MATTER_COUNT);
  if (!Number.isInteger(matters) || matters < 1) {
    fail(`--matters must be a positive integer, got '${matters}'.`);
  }
  return { apiOrigin: read("--api"), matters };
};

/** Blobless sparse clone: only the seeded matters are materialised. */
const ensureCorpus = async (matterCount: number): Promise<string> => {
  const cache = path.join(process.cwd(), CACHE_DIRECTORY);
  const cloned = await stat(path.join(cache, ".git")).then(
    () => true,
    () => false,
  );

  if (!cloned) {
    console.log(`Cloning ${CORPUS_REPOSITORY} into ${CACHE_DIRECTORY} ...`);
    const clone = Bun.spawnSync([
      "git",
      "clone",
      "--filter=blob:none",
      "--sparse",
      "--depth=1",
      CORPUS_REPOSITORY,
      cache,
    ]);
    if (clone.exitCode !== 0) {
      fail(`Corpus clone failed: ${clone.stderr.toString()}`);
    }
  }

  // ls-tree reads the manifest without materialising anything.
  const list = Bun.spawnSync(
    ["git", "ls-tree", "--name-only", "HEAD", `${CORPUS_SUBPATH}/`],
    { cwd: cache },
  );
  if (list.exitCode !== 0) {
    fail(`Could not list corpus matters: ${list.stderr.toString()}`);
  }
  const matters = list.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((entry) => path.basename(entry))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, matterCount);

  if (matters.length === 0) {
    fail("Corpus listing returned no matters.");
  }

  const sparse = Bun.spawnSync(
    [
      "git",
      "sparse-checkout",
      "set",
      ...matters.map((matter) => `${CORPUS_SUBPATH}/${matter}`),
    ],
    { cwd: cache },
  );
  if (sparse.exitCode !== 0) {
    fail(`Sparse checkout failed: ${sparse.stderr.toString()}`);
  }

  console.log(`Corpus ready: ${matters.length} matters in ${CACHE_DIRECTORY}`);
  return path.join(cache, CORPUS_SUBPATH);
};

/** Keys are corpus-relative paths, matching the browser's `webkitRelativePath`. */
const readMatter = async (matterRoot: string): Promise<MatterManifest> => {
  const directories: TreeDirectory[] = [];
  const files: TreeFile[] = [];

  const walk = async (directory: string, parentKey: string | null) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const key = path.relative(matterRoot, absolutePath);

      if (entry.isDirectory()) {
        directories.push({ key, parentKey, name: entry.name });
        // oxlint-disable-next-line no-await-in-loop -- depth-first keeps parents before children
        await walk(absolutePath, key);
        continue;
      }

      const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = MIME_TYPES[extension];
      if (!mimeType) {
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- hashing is the browser's own work
      const bytes = await Bun.file(absolutePath).bytes();
      files.push({
        absolutePath,
        key,
        mimeType,
        name: entry.name,
        parentKey,
        sha256Hex: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      });
    }
  };

  await walk(matterRoot, null);
  return { directories, files, reference: path.basename(matterRoot) };
};

/**
 * The stored state carries a fixed cookie name, which a worktree's API rejects
 * with a silent 401. The signature covers the token alone, so reuse the value
 * and relabel it for the target port.
 */
const readSessionCookie = async (apiOrigin: string): Promise<string> => {
  const statePath = path.join(process.cwd(), "..", "..", STORAGE_STATE);
  const file = Bun.file(statePath);
  if (!(await file.exists())) {
    fail(
      `No session at ${STORAGE_STATE}. Run 'bun run db:seed-test-user' first.`,
    );
  }
  const state: { cookies?: { name: string; value: string }[] } =
    await file.json();
  const sessionCookie = (state.cookies ?? []).find(({ name }) =>
    name.endsWith(SESSION_COOKIE_SUFFIX),
  );
  if (!sessionCookie) {
    fail(`${STORAGE_STATE} carries no ${SESSION_COOKIE_SUFFIX} cookie.`);
  }

  const { port } = new URL(apiOrigin);
  if (!port) {
    fail(`--api origin '${apiOrigin}' must include a port.`);
  }
  return `${sessionCookieNameForDevPort(port)}=${sessionCookie.value}`;
};

const createApiClient = (apiOrigin: string, cookie: string) => {
  const request = async <T>(
    route: string,
    init?: { body?: unknown; method?: string },
  ): Promise<T> => {
    // Every route used here is mounted inside the versioned group, so the
    // prefix is applied once rather than repeated at each call site.
    const url = `${apiOrigin}${STELLA_API_VERSION_PREFIX}${route}`;
    const response = await fetch(url, {
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        cookie,
        ...(init?.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      method: init?.method ?? "GET",
    });
    if (!response.ok) {
      fail(
        `${init?.method ?? "GET"} ${url} -> ${response.status} ${await response.text()}`,
      );
    }
    // SAFETY: dev-only script; each call site declares the shape it expects and
    // a mismatch fails the run immediately.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    return (await response.json()) as T;
  };
  return { request };
};

const main = async () => {
  const { apiOrigin: explicitOrigin, matters: matterCount } = parseArgs();
  const apiOrigin = explicitOrigin ?? (await discoverApiOrigin());
  const cookie = await readSessionCookie(apiOrigin);
  const api = createApiClient(apiOrigin, cookie);
  const corpusRoot = await ensureCorpus(matterCount);

  const matterDirectories = (
    await readdir(corpusRoot, { withFileTypes: true })
  ).filter((entry) => entry.isDirectory());

  // The API suffixes duplicate names "(1)", "(2)", so re-runs would stack copies.
  const existing = await api.request<{
    workspaces: { entityCount: number; name: string }[];
  }>("/workspaces");
  // Keyed on entity count, not name: a run interrupted mid-upload leaves the
  // matter present but short, and skipping on name alone would strand it.
  const seededCounts = new Map(
    existing.workspaces.map(({ entityCount, name }) => [name, entityCount]),
  );

  let seededFiles = 0;
  let skipped = 0;

  for (const matterDirectory of matterDirectories) {
    // oxlint-disable-next-line no-await-in-loop -- one matter at a time keeps the queue depth sane
    const manifest = await readMatter(
      path.join(corpusRoot, matterDirectory.name),
    );
    if (manifest.files.length === 0) {
      continue;
    }
    const expectedEntities =
      manifest.files.length + manifest.directories.length;
    if (
      (seededCounts.get(matterName(manifest.reference)) ?? 0) >=
      expectedEntities
    ) {
      skipped += 1;
      continue;
    }

    // Minted client-side, as the web app does.
    const workspaceId = Bun.randomUUIDv7();

    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    await api.request("/workspaces", {
      body: {
        filePropertyName: FILE_PROPERTY_NAME,
        id: workspaceId,
        name: matterName(manifest.reference),
        queryKey: WORKSPACES_QUERY_KEY,
      },
      method: "PUT",
    });

    // The tree endpoint needs the file property id; the create response omits it.
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    const properties = await api.request<WorkspaceProperty[]>(
      `/properties/${workspaceId}`,
    );
    const fileProperty = properties.find(
      ({ content }) => content.type === "file",
    );
    if (!fileProperty) {
      fail(`Matter ${manifest.reference} has no file property.`);
    }

    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    const signed = await api.request<{ files: SignedFile[] }>(
      `/uploads/${workspaceId}/entity-create/tree`,
      {
        body: {
          directories: manifest.directories,
          files: manifest.files.map(({ absolutePath: _drop, ...file }) => file),
          propertyId: fileProperty.id,
          queryKey: entitiesQueryKey(workspaceId),
        },
        method: "POST",
      },
    );

    const byKey = new Map(manifest.files.map((file) => [file.key, file]));
    for (const { headers, key, uploadId, url } of signed.files) {
      const file = byKey.get(key);
      if (!file) {
        fail(`Server signed an unknown key '${key}'.`);
      }

      // oxlint-disable-next-line no-await-in-loop -- sequential, as the browser uploads
      const body = await Bun.file(file.absolutePath).bytes();
      // oxlint-disable-next-line no-await-in-loop -- sequential, as the browser uploads
      const put = await fetch(url, {
        body,
        headers: { ...headers, "content-type": file.mimeType },
        method: "PUT",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!put.ok) {
        fail(`Upload of ${file.name} failed: ${put.status}`);
      }

      // oxlint-disable-next-line no-await-in-loop -- finalize follows its own PUT
      await api.request(`/uploads/${workspaceId}/${uploadId}/finalize`, {
        body: { queryKey: entitiesQueryKey(workspaceId) },
        method: "POST",
      });
      seededFiles += 1;
    }

    console.log(
      `${manifest.reference}: ${manifest.files.length} files, ${manifest.directories.length} folders`,
    );
  }

  const seededMatters = matterDirectories.length - skipped;
  console.log(
    `\nSeeded ${seededFiles} files across ${seededMatters} ${
      seededMatters === 1 ? "matter" : "matters"
    }${skipped > 0 ? `; skipped ${skipped} already present.` : "."}`,
  );
  console.log(
    "Derivatives and extraction are queued; spreadsheets and decks stay " +
      "unopenable until Gotenberg finishes converting them.",
  );
};

await main();
