/**
 * Selective Save Tripwire
 *
 * Compares the bytes produced by selective save against a full repack of the
 * same document, so CI and local soak can detect divergence between the two
 * paths before it reaches a user's `.docx`.
 *
 * Tripwire NEVER blocks a save. The host receives a structured `TripwireResult`
 * via callback and decides what to do (log, surface as observability event,
 * fail a CI assertion, etc.).
 *
 * The diff ignores `docProps/core.xml` because both paths refresh
 * `dcterms:modified` with the current wall clock and would always disagree.
 */

const IGNORED_PATHS = new Set<string>(["docProps/core.xml"]);

export type TripwireResult =
  | { kind: "match" }
  | { kind: "selective-skipped"; reason: string }
  | {
      kind: "entry-set-diff";
      onlyInSelective: readonly string[];
      onlyInFull: readonly string[];
    }
  | {
      kind: "entry-byte-diff";
      path: string;
      selectiveSize: number;
      fullSize: number;
    };

type ZipLike = {
  files: Record<string, { dir: boolean }>;
  file(path: string): { async(type: "uint8array"): Promise<Uint8Array> } | null;
};

async function listEntries(buffer: ArrayBuffer): Promise<{
  zip: ZipLike;
  paths: string[];
}> {
  const JSZip = (await import("jszip")).default;
  const zip = (await JSZip.loadAsync(buffer)) as unknown as ZipLike;
  const paths: string[] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      continue;
    }
    if (IGNORED_PATHS.has(path)) {
      continue;
    }
    paths.push(path);
  }
  paths.sort();
  return { zip, paths };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export async function compareSelectiveVsFull(
  selective: ArrayBuffer | null,
  full: ArrayBuffer,
): Promise<TripwireResult> {
  if (selective === null) {
    return { kind: "selective-skipped", reason: "selective-returned-null" };
  }

  const [selectiveZip, fullZip] = await Promise.all([
    listEntries(selective),
    listEntries(full),
  ]);

  const selectiveSet = new Set(selectiveZip.paths);
  const fullSet = new Set(fullZip.paths);

  const onlyInSelective: string[] = [];
  const onlyInFull: string[] = [];
  for (const path of selectiveSet) {
    if (!fullSet.has(path)) {
      onlyInSelective.push(path);
    }
  }
  for (const path of fullSet) {
    if (!selectiveSet.has(path)) {
      onlyInFull.push(path);
    }
  }

  if (onlyInSelective.length > 0 || onlyInFull.length > 0) {
    return { kind: "entry-set-diff", onlyInSelective, onlyInFull };
  }

  for (const path of selectiveZip.paths) {
    const a = await selectiveZip.zip.file(path)?.async("uint8array");
    const b = await fullZip.zip.file(path)?.async("uint8array");
    if (!a || !b) {
      continue;
    }
    if (!bytesEqual(a, b)) {
      return {
        kind: "entry-byte-diff",
        path,
        selectiveSize: a.length,
        fullSize: b.length,
      };
    }
  }

  return { kind: "match" };
}
