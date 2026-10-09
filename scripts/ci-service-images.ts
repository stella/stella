import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import mirrorImages from "./ci-service-images.json" with { type: "json" };

const canonicalTag = (tagged: string) => {
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

const canonicalImage = (reference: string) => {
  const [tagged = reference, digest] = reference.split("@");
  const canonical = canonicalTag(tagged);
  return digest ? `${canonical}@${digest}` : canonical;
};

const needsMirror = (reference: string) =>
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
    /(?:\bimage:\s*["']?|\b(?:[A-Za-z_]\w*_)?image=\s*["']?|^FROM\s+(?:--platform=\S+\s+)?|\bdocker\s+pull\s+)((?:[a-z0-9.-]+\/)*[a-z0-9.-]+:[A-Za-z0-9_.-]+)(?:@sha256:[a-f0-9]{64})?/gmu;
  for (const match of active.matchAll(declarations)) {
    const reference = match.at(1);
    if (reference && !match[0].includes("@sha256:")) {
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

export const mirrorImageReference = ({ source, name }: MirrorImage) => {
  const separator = source.indexOf("@");
  assert.ok(separator !== -1, `Unpinned mirror source: ${source}`);
  const tagged = source.slice(0, separator);
  const digest = source.slice(separator + 1);
  const tag = tagged.slice(tagged.lastIndexOf(":") + 1);
  return `ghcr.io/stella/ci-mirror/${name}:${tag}@${digest}`;
};

export const compareCiMirrorReferences = (
  references: readonly string[],
  images: readonly MirrorImage[],
) => {
  const expected = new Set(
    images.flatMap((image) => [image.source, mirrorImageReference(image)]),
  );
  return references
    .filter((reference) => !expected.has(canonicalImage(reference)))
    .map((reference) => `Unknown or digest-mismatched CI image: ${reference}`);
};

type ResolveImageOptions = {
  reference: string;
  enabled: boolean;
  available: (reference: string) => Promise<boolean>;
};

export const resolveImageReference = async ({
  reference,
  enabled,
  available,
}: ResolveImageOptions) => {
  const canonical = canonicalImage(reference);
  const image = mirrorImages.find(({ source }) => source === canonical);
  if (!image || !enabled) {
    return reference;
  }
  const mirror = mirrorImageReference(image);
  return (await available(mirror)) ? mirror : reference;
};

const mirrorAvailable = async (reference: string) => {
  const child = Bun.spawn(
    ["docker", "buildx", "imagetools", "inspect", reference],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const available = (await child.exited) === 0;
  if (!available) {
    process.stderr.write(
      `CI mirror unavailable: ${reference}; using the pinned upstream image\n`,
    );
  }
  return available;
};

export const dockerfileImages = (text: string) => [
  ...new Set(
    text.split("\n").flatMap((line) => {
      const tokens = line.trim().split(/\s+/u);
      if (tokens.at(0)?.toUpperCase() !== "FROM") {
        return [];
      }
      const image = tokens.at(tokens.at(1)?.startsWith("--platform=") ? 2 : 1);
      return image?.includes("@sha256:") ? [image] : [];
    }),
  ),
];

export const compareProductMirrorReferences = async (
  root: string,
  files: readonly string[],
) => {
  const problems: string[] = [];
  for (const file of files) {
    if (
      file.startsWith(".github/") ||
      file.startsWith("scripts/ci-") ||
      file.startsWith(".git/") ||
      file.includes("node_modules/") ||
      file.includes(".venv/") ||
      file.includes(".turbo/") ||
      file.includes("dist/")
    ) {
      continue;
    }
    if (
      !/\.(?:yml|yaml|ts|sh|txt|md|json)$/u.test(file) &&
      !file.endsWith("Dockerfile")
    ) {
      continue;
    }
    if (
      (await Bun.file(path.join(root, file)).text()).includes(
        "ghcr.io/stella/ci-mirror/",
      )
    ) {
      problems.push(`Product file references a CI mirror: ${file}`);
    }
  }
  return problems;
};

export const compareMirrorImages = (
  references: readonly string[],
  images: readonly MirrorImage[],
): string[] => {
  const problems: string[] = [];
  const sources = new Set<string>();
  const names = new Set<string>();
  for (const { source, name } of images) {
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)+\/(?:[a-z0-9.-]+\/)*[a-z0-9.-]+:[A-Za-z0-9_.-]+@sha256:[a-f0-9]{64}$/u.test(
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

export const composeImageOverrides = async (
  text: string,
  resolve: (reference: string) => Promise<string>,
  root: string,
) => {
  const document: unknown = Bun.YAML.parse(text);
  assert.ok(
    typeof document === "object" &&
      document !== null &&
      "services" in document &&
      typeof document.services === "object" &&
      document.services !== null,
    "Compose services are required",
  );
  const services = new Map<
    string,
    { image?: string; build?: { additional_contexts: Record<string, string> } }
  >();
  for (const [name, service] of Object.entries(document.services)) {
    if (typeof service !== "object" || service === null) {
      continue;
    }
    const override: {
      image?: string;
      build?: { additional_contexts: Record<string, string> };
    } = {};
    if ("image" in service && typeof service.image === "string") {
      const image = await resolve(service.image);
      if (image !== service.image) {
        override.image = image;
      }
    }
    if (
      "build" in service &&
      typeof service.build === "object" &&
      service.build !== null &&
      "dockerfile" in service.build &&
      typeof service.build.dockerfile === "string"
    ) {
      const context =
        "context" in service.build && typeof service.build.context === "string"
          ? service.build.context
          : ".";
      const images = dockerfileImages(
        await Bun.file(
          path.resolve(root, context, service.build.dockerfile),
        ).text(),
      );
      const additional_contexts = new Map<string, string>();
      for (const image of images) {
        const resolved = await resolve(image);
        if (resolved !== image) {
          additional_contexts.set(image, `docker-image://${resolved}`);
        }
      }
      if (additional_contexts.size) {
        override.build = {
          additional_contexts: Object.fromEntries(additional_contexts),
        };
      }
    }
    if (Object.keys(override).length) {
      services.set(name, override);
    }
  }
  return { services: Object.fromEntries(services) };
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  const mode = args.at(0);
  const enabled = process.env["CI_IMAGE_MIRROR_ENABLED"] === "true";
  const resolve = (reference: string) =>
    resolveImageReference({ reference, enabled, available: mirrorAvailable });
  if (mode === "--image") {
    const reference = args.at(1);
    assert.ok(reference, "An image reference is required");
    process.stdout.write(`${await resolve(reference)}\n`);
  } else if (mode === "--compose") {
    const file = args.at(1);
    assert.ok(file, "A Compose file is required");
    process.stdout.write(
      `${JSON.stringify(await composeImageOverrides(await Bun.file(file).text(), resolve, path.dirname(path.resolve(file))))}\n`,
    );
  } else if (mode === "--resolve") {
    for (const { source, name } of mirrorImages) {
      process.stdout.write(`${name}=${await resolve(source)}\n`);
    }
  } else if (
    mode === "--build-contexts" ||
    mode === "--build" ||
    mode === "--pull"
  ) {
    const file = args.at(1);
    assert.ok(file, "A Dockerfile path is required");
    const images = dockerfileImages(await Bun.file(file).text());
    const contexts: string[] = [];
    for (const image of images) {
      const resolved = await resolve(image);
      if (mode === "--pull") {
        const child = Bun.spawn(
          [
            "bash",
            path.join(import.meta.dir, "retry.sh"),
            "docker",
            "pull",
            resolved,
          ],
          {
            stdout: "inherit",
            stderr: "inherit",
          },
        );
        const status = await child.exited;
        if (status !== 0) {
          process.exit(childExitStatus(child));
        }
      } else if (resolved !== image) {
        contexts.push(`${image}=docker-image://${resolved}`);
      }
    }
    if (mode === "--build-contexts") {
      process.stdout.write(contexts.length ? `${contexts.join("\n")}\n` : "");
    } else if (mode === "--build") {
      const separator = args.indexOf("--");
      assert.ok(separator !== -1, "Build arguments must follow --");
      const child = Bun.spawn(
        [
          "docker",
          "buildx",
          "build",
          "--load",
          ...contexts.flatMap((context) => ["--build-context", context]),
          ...args.slice(separator + 1),
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      await child.exited;
      process.exit(childExitStatus(child));
    }
  } else {
    const references = await collectImageReferences(root);
    const problems = compareMirrorImages(
      mirrorImages.map(({ source }) => source),
      mirrorImages,
    );
    problems.push(...compareCiMirrorReferences(references, mirrorImages));
    if (mode !== "--list") {
      const tracked = Bun.spawn(["git", "ls-files", "-z"], {
        cwd: root,
        stdout: "pipe",
        stderr: "inherit",
      });
      const files = (await new Response(tracked.stdout).text())
        .split("\0")
        .filter(Boolean);
      if ((await tracked.exited) !== 0) {
        process.exit(1);
      }
      problems.push(...(await compareProductMirrorReferences(root, files)));
    }
    if (problems.length > 0) {
      process.stderr.write(`${problems.join("\n")}\n`);
      process.exit(1);
    }
    if (args.includes("--list")) {
      for (const { source, name } of mirrorImages) {
        process.stdout.write(`${source}\t${name}\n`);
      }
    }
  }
}
