/**
 * Spec-drift sentinel: the auth.md protocol we implement must not move
 * out from under us without someone noticing.
 *
 * auth.md is a pre-1.0, fast-moving open protocol (6 versions in its
 * first 3 weeks; v0.6.0 broke `service_auth` out of `identity_assertion`).
 * We implement against a pinned version, so an upstream change is not an
 * emergency — but it IS something a human must review and reconcile
 * (update our manifest / discovery / flow handlers, then re-pin). This
 * check turns "upstream silently changed" into a loud, scheduled CI
 * failure that points at exactly what moved.
 *
 * It pins the prose spec artifacts (the protocol has no JSON schema —
 * the contract lives in the changelog, the AUTH.md skill doc, and the
 * reference-impl READMEs) by sha256, plus the changelog's latest version
 * string. Two signals:
 *   1. VERSION_BUMP — upstream CHANGELOG advertises a version newer than
 *      the one we pinned. The primary "the spec moved" signal; also
 *      catches additions (a new doc shows up in a versioned release).
 *   2. FILE_CHANGED — a pinned file's content hash differs from the
 *      lockfile, even within the same version (errata, clarifications).
 *
 * A reviewed-but-not-yet-reconciled change can be parked in ACKNOWLEDGED
 * (with a dated note) so the check goes green until the work lands —
 * which the next real change then catches again.
 *
 * Usage:
 *   bun packages/scripts/src/auth-md-spec-drift.ts            # check (CI)
 *   bun packages/scripts/src/auth-md-spec-drift.ts --update   # re-pin lockfile
 */

const REPO = "workos/auth.md";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}`;
const COMMITS_API = `https://api.github.com/repos/${REPO}/commits/main`;
const FETCH_TIMEOUT_MS = 15_000;

const LOCKFILE_URL = new URL("./auth-md-spec.lock.json", import.meta.url);

/**
 * The curated spec surface we track. The protocol ships no machine
 * schema, so these prose artifacts ARE the contract: the changelog
 * (version + rationale), the skill manifest agents read, and the
 * service/provider reference READMEs that define discovery, validation,
 * and the flow shapes. Impl source files are deliberately excluded —
 * they churn on refactors unrelated to the protocol.
 */
const PINNED_FILES = [
  "CHANGELOG.md",
  "AUTH.md",
  "README.md",
  "agent-services/README.md",
  "agent-providers/README.md",
] as const;

/**
 * Upstream changes a human has reviewed but not yet reconciled into our
 * implementation. Park the moved artifact here with a dated note so the
 * check stays green until the work lands; never park to hide a change
 * we have not actually looked at. Keyed by pinned-file path, or the
 * literal "version" to acknowledge a VERSION_BUMP.
 */
type AcknowledgementKey = (typeof PINNED_FILES)[number] | "version";

// e.g. ACKNOWLEDGED.add("AUTH.md"); // reviewed 2026-06-21, reconciling in #NNN
const ACKNOWLEDGED = new Set<AcknowledgementKey>();

type Lockfile = {
  /** Pinned spec version, parsed from the upstream CHANGELOG at pin time. */
  version: string;
  /** Upstream main HEAD commit captured at pin time (provenance only). */
  commit: string;
  /** ISO date the pin was captured (provenance only). */
  capturedAt: string;
  /** Pinned-file path → sha256 hex of its raw content at pin time. */
  files: Record<string, string>;
};

const sha256 = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

const asMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type FetchResult = { ok: true; text: string } | { ok: false; reason: string };

const fetchText = async (url: string): Promise<FetchResult> => {
  try {
    const headers: Record<string, string> = {};
    const token = process.env["GITHUB_TOKEN"];
    if (token && url.startsWith("https://api.github.com")) {
      headers["authorization"] = `Bearer ${token}`;
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
    });
    if (!response.ok) {
      return { ok: false, reason: `responded ${response.status}` };
    }
    return { ok: true, text: await response.text() };
  } catch (error) {
    return { ok: false, reason: asMessage(error) };
  }
};

/** First `## vX.Y.Z (...)` heading in the upstream changelog. */
const parseChangelogVersion = (changelog: string): string | null =>
  changelog.match(/^##\s+v(\d+\.\d+\.\d+)/mu)?.[1] ?? null;

const rawUrl = (path: string): string => `${RAW_BASE}/main/${path}`;

const readLockfile = async (): Promise<Lockfile | null> => {
  const file = Bun.file(LOCKFILE_URL);
  if (!(await file.exists())) {
    return null;
  }
  return (await file.json()) as Lockfile;
};

const update = async (): Promise<void> => {
  console.log(`Re-pinning auth.md spec from ${REPO}@main…`);

  const commit = await fetchText(COMMITS_API);
  const commitSha = commit.ok
    ? (JSON.parse(commit.text)["sha"] as string)
    : "unknown";

  const files: Record<string, string> = {};
  for (const path of PINNED_FILES) {
    const result = await fetchText(rawUrl(path));
    if (!result.ok) {
      console.error(`  ✗ ${path}: ${result.reason}`);
      process.exit(1);
    }
    files[path] = sha256(result.text);
    console.log(`  · ${path} → ${files[path].slice(0, 12)}…`);
  }

  const changelog = await fetchText(rawUrl("CHANGELOG.md"));
  const version =
    changelog.ok && parseChangelogVersion(changelog.text) !== null
      ? (parseChangelogVersion(changelog.text) as string)
      : "unknown";

  const lockfile: Lockfile = {
    version,
    commit: commitSha,
    capturedAt: new Date().toISOString().slice(0, 10),
    files,
  };
  await Bun.write(LOCKFILE_URL, `${JSON.stringify(lockfile, null, 2)}\n`);
  console.log(
    `\n✓ Pinned auth.md spec v${version} (${commitSha.slice(0, 12)}).`,
  );
};

type Drift =
  | { kind: "version_bump"; detail: string }
  | { kind: "file_changed"; detail: string }
  | { kind: "file_set_changed"; detail: string };

const check = async (): Promise<void> => {
  console.log(`Checking auth.md spec for upstream drift (${REPO}@main)…`);

  const lockfile = await readLockfile();
  if (lockfile === null) {
    console.error(
      "\n✗ No lockfile. Run `bun run check:auth-md-spec --update` to pin first.",
    );
    process.exit(1);
  }

  const drifts: { key: AcknowledgementKey; drift: Drift }[] = [];
  let unreachable = 0;

  // The pinned set itself must match the lockfile; a maintainer editing
  // PINNED_FILES without re-pinning is its own (local) drift.
  const lockedPaths = Object.keys(lockfile.files).sort();
  const pinnedPaths = [...PINNED_FILES].sort();
  if (lockedPaths.join(",") !== pinnedPaths.join(",")) {
    drifts.push({
      key: "version",
      drift: {
        kind: "file_set_changed",
        detail: `PINNED_FILES (${pinnedPaths.join(", ")}) ≠ lockfile (${lockedPaths.join(", ")}); re-pin with --update`,
      },
    });
  }

  for (const path of PINNED_FILES) {
    const result = await fetchText(rawUrl(path));
    if (!result.ok) {
      console.warn(`  ⚠ ${path}: unreachable (${result.reason})`);
      unreachable += 1;
      continue;
    }
    const current = sha256(result.text);
    const pinned = lockfile.files[path];
    if (pinned !== undefined && current !== pinned) {
      drifts.push({
        key: path,
        drift: {
          kind: "file_changed",
          detail: `content changed (${pinned.slice(0, 8)}… → ${current.slice(0, 8)}…)`,
        },
      });
    }
  }

  const changelog = await fetchText(rawUrl("CHANGELOG.md"));
  if (changelog.ok) {
    const upstreamVersion = parseChangelogVersion(changelog.text);
    if (upstreamVersion !== null && upstreamVersion !== lockfile.version) {
      drifts.push({
        key: "version",
        drift: {
          kind: "version_bump",
          detail: `pinned v${lockfile.version} → upstream v${upstreamVersion}`,
        },
      });
    }
  } else {
    console.warn(`  ⚠ CHANGELOG.md: unreachable (${changelog.reason})`);
    unreachable += 1;
  }

  if (unreachable === PINNED_FILES.length + 1) {
    console.error(
      "\n✗ Every upstream source was unavailable; spec drift could not be verified.",
    );
    process.exit(1);
  }

  const actionable = drifts.filter(({ key, drift }) => {
    // ACKNOWLEDGED is intentionally empty by default — it's the set
    // maintainers use to park a reviewed-but-unreconciled change.
    // eslint-disable-next-line sonarjs/no-empty-collection -- maintainer-populated extension point, empty by design
    if (ACKNOWLEDGED.has(key)) {
      console.log(`  · acknowledged ${drift.kind} (${key}): ${drift.detail}`);
      return false;
    }
    return true;
  });

  console.log(
    `\nChecked auth.md spec v${lockfile.version} (${PINNED_FILES.length} pinned files).`,
  );

  if (actionable.length > 0) {
    console.error(
      `\n✗ auth.md spec drifted upstream — ${actionable.length} change(s) need review:`,
    );
    for (const { key, drift } of actionable) {
      const label = drift.kind.toUpperCase();
      console.error(`  ✗ [${label}] ${key} — ${drift.detail}`);
    }
    console.error(
      "\nReconcile by reviewing the upstream diff, updating our manifest /\n" +
        "discovery / flow handlers to match, then re-pinning with\n" +
        "`bun run check:auth-md-spec --update`. If a change is reviewed but\n" +
        "reconciliation is deferred, add its key to ACKNOWLEDGED with a dated note.",
    );
    process.exit(1);
  }

  if (unreachable > 0) {
    console.log("\n✓ No drift in the spec artifacts that were reachable.");
    return;
  }

  console.log("\n✓ auth.md spec matches our pin; no upstream drift.");
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--update")) {
    await update();
    return;
  }
  await check();
};

await main();
