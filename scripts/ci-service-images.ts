import { existsSync, statSync } from "node:fs";
import path from "node:path";

import mirrorImages from "./ci-service-images.json";

const canonicalImage = (reference: string) => {
  const tagged = reference.split("@").at(0) ?? reference;
  if (/^docker\.io\/[^/]+$/u.test(tagged)) {
    return tagged.replace("docker.io/", "docker.io/library/");
  }
  const first = tagged.split("/").at(0) ?? tagged;
  if (first.includes(".") || first.includes(":")) {
    return tagged.includes("/") ? tagged : `docker.io/library/${tagged}`;
  }
  return tagged.includes("/")
    ? `docker.io/${tagged}`
    : `docker.io/library/${tagged}`;
};

const needsMirror = (reference: string) =>
  !reference.startsWith("ghcr.io/") &&
  !reference.startsWith("public.ecr.aws/") &&
  !/^[^/]+\.dkr\.ecr\.[^/]+\.amazonaws\.com\//u.test(reference);

// Read literals in service declarations, shell commands and Dockerfile bases.
// The reachability walk below also follows files holding image variables.
const extractImageReferences = (text: string): string[] => {
  const sources = new Set<string>();
  const active = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const pattern =
    /(?<![\w/:.-])((?:[a-z0-9.-]+\/)*[a-z0-9.-]+:[A-Za-z0-9_.-]+@sha256:[a-f0-9]{64})(?![a-f0-9])/gu;
  for (const match of active.matchAll(pattern)) {
    const reference = match.at(1);
    if (reference) {
      sources.add(canonicalImage(reference));
    }
  }
  // Also catch new tag-only image declarations and literal docker operands.
  const declarations =
    /(?:\bimage:\s*["']?|\b(?:[A-Za-z_]\w*_)?image=\s*["']?|^FROM\s+(?:--platform=\S+\s+)?|\bdocker\s+pull\s+)((?:[a-z0-9.-]+\/)*[a-z0-9.-]+:[A-Za-z0-9_.-]+)/gmu;
  for (const match of active.matchAll(declarations)) {
    const reference = match.at(1);
    if (reference) {
      sources.add(canonicalImage(reference));
    }
  }
  const commands = active.replaceAll(/\\\r?\n/gu, " ");
  for (const command of commands.matchAll(
    /\bdocker\s+(?:run|pull)\s+[^\n]+/gu,
  )) {
    for (const token of command[0].split(/\s+/u)) {
      const reference = token.replaceAll(/^["']|["';]$/gu, "");
      if (
        /^(?:[a-z0-9.-]+\/)*[a-z][a-z0-9.-]*:[A-Za-z0-9_.-]+(?:@sha256:[a-f0-9]{64})?$/u.test(
          reference,
        )
      ) {
        sources.add(canonicalImage(reference));
      }
    }
  }
  return [...sources].filter(needsMirror).toSorted();
};

export const collectImageReferences = async (
  root: string,
): Promise<string[]> => {
  const queue = [
    ...new Bun.Glob(".github/{workflows,actions}/**/*.{yml,yaml}").scanSync({
      cwd: root,
    }),
  ];
  const visited = new Set<string>();
  const sources = new Set<string>();
  const localImages = new Set<string>();
  while (queue.length > 0) {
    const relative = queue.pop();
    if (
      !relative ||
      visited.has(relative) ||
      /\.test\.(?:sh|ts)$/u.test(relative)
    ) {
      continue;
    }
    visited.add(relative);
    const absolute = path.resolve(root, relative);
    if (
      !absolute.startsWith(`${path.resolve(root)}${path.sep}`) ||
      !existsSync(absolute) ||
      !statSync(absolute).isFile()
    ) {
      continue;
    }
    const text = await Bun.file(absolute).text();
    for (const match of text.matchAll(
      /(?:--tag|-t)\s+["']?([a-z0-9./-]+:[A-Za-z0-9_.-]+)/gu,
    )) {
      const image = match.at(1);
      if (image) {
        localImages.add(canonicalImage(image));
      }
    }
    for (const reference of extractImageReferences(text)) {
      sources.add(reference);
    }
    // Checkout directories may prefix the same repository-relative path.
    // Tokenize once before checking suffixes; a failing suffix must not
    // restart a directory walk at every slash in a long path.
    const files = /[\w./-]+/gu;
    for (const match of text.matchAll(files)) {
      let candidate = match[0].replace(/^\/+/u, "");
      if (
        !candidate.includes("/") ||
        !(
          /\.(?:sh|txt|ya?ml)$/u.test(candidate) ||
          candidate.endsWith("/Dockerfile") ||
          candidate.endsWith(".Dockerfile")
        )
      ) {
        continue;
      }
      while (
        !existsSync(path.join(root, candidate)) &&
        candidate.includes("/")
      ) {
        candidate = candidate.slice(candidate.indexOf("/") + 1);
      }
      if (existsSync(path.join(root, candidate))) {
        queue.push(candidate);
      }
    }
    for (const command of text
      .replaceAll(/\\\r?\n/gu, " ")
      .matchAll(/\bdocker\s+compose\s+[^\n]+/gu)) {
      if (!/(?:^|\s)(?:-f|--file)(?:\s|=)/u.test(command[0])) {
        queue.push("docker-compose.yml");
      }
    }
  }
  return [...sources].filter((source) => !localImages.has(source)).toSorted();
};

type MirrorImage = { source: string; name: string };

export const compareMirrorImages = (
  references: readonly string[],
  images: readonly MirrorImage[],
): string[] => {
  const problems: string[] = [];
  const sources = new Set<string>();
  const names = new Set<string>();
  for (const { source, name } of images) {
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)+\/(?:[a-z0-9.-]+\/)*[a-z0-9.-]+:[A-Za-z0-9_.-]+$/u.test(
        source,
      ) ||
      canonicalImage(source) !== source ||
      !needsMirror(source)
    ) {
      problems.push(`Invalid mirror source: ${source}`);
    }
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(name)) {
      problems.push(`Invalid mirror name: ${name}`);
    }
    if (sources.has(source)) {
      problems.push(`Duplicate mirror source: ${source}`);
    }
    if (names.has(name)) {
      problems.push(`Duplicate mirror name: ${name}`);
    }
    sources.add(source);
    names.add(name);
  }
  for (const source of references) {
    if (!sources.has(source)) {
      problems.push(`Missing mirror source: ${source}`);
    }
  }
  for (const source of sources) {
    if (!references.includes(source)) {
      problems.push(`Unused mirror source: ${source}`);
    }
  }
  return problems;
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const problems = compareMirrorImages(
    await collectImageReferences(root),
    mirrorImages,
  );
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  if (process.argv.includes("--list")) {
    for (const { source, name } of mirrorImages) {
      process.stdout.write(`${source}\t${name}\n`);
    }
  }
}
