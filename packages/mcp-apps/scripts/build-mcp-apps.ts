import tailwindcss from "@tailwindcss/postcss";
import { panic, Result } from "better-result";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";

import MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages";
import { repoRelativePath } from "@stll/portable-path";
import { reactCompilerBunPlugin } from "@stll/scripts/src/react-compiler-bun-plugin";
import { parseSource } from "@stll/scripts/src/syntax-tree";

import { formattedArtifactsLikeRepository } from "../../../scripts/generated-artifacts";
import readerPackage from "../../decision-reader/package.json";
import { assembleMcpAppDocument } from "../src/app-document";
import type { McpAppDocumentParts } from "../src/app-document";
import {
  READER_MESSAGE_KEYS,
  READER_TEMPLATE_KEYS,
} from "../src/decision-reader/message-keys";
import { MCP_APPS } from "../src/manifest";
import type { McpAppDirectory } from "../src/manifest";
import {
  inspectMcpAppDocument,
  inspectMcpAppHtml,
} from "./lib/mcp-app-html-guard";
import {
  inspectMcpReaderUi,
  MCP_READER_UI_APP_DIRECTORIES,
} from "./lib/mcp-reader-ui-guard";
import { namespaceMembers } from "./lib/namespace-members";

const checking = Bun.argv.includes("--check");
const generatedAssets = new Map<string, string>();
const writeGenerated = async (file: string, contents: string) => {
  if (checking) {
    generatedAssets.set(file, contents);
    return;
  }
  await Bun.write(file, contents);
};
const generatedAssetPlugin = {
  name: "generated-mcp-assets",
  setup(builder: Bun.PluginBuilder) {
    builder.onResolve(
      { filter: /generated\//u },
      ({ path: specifier, resolveDir }) => {
        const file = path.resolve(resolveDir, specifier);
        if (generatedAssets.has(file)) {
          return { path: file };
        }
        return undefined;
      },
    );
    builder.onLoad({ filter: /shared\/generated\//u }, ({ path: file }) => {
      const contents = generatedAssets.get(file);
      if (contents === undefined) {
        return undefined;
      }
      return { contents, loader: file.endsWith(".css") ? "css" : "json" };
    });
  },
} satisfies Bun.BunPlugin;

const generatedRoot = path.resolve(
  import.meta.dirname,
  "../src/shared/generated",
);
await writeGenerated(
  path.join(generatedRoot, "messages.json"),
  `${JSON.stringify(MCP_APP_MESSAGES, null, 2)}\n`,
);
const styleInput = path.resolve(generatedRoot, "../style.css");
const styles = await postcss([tailwindcss()]).process(
  await Bun.file(styleInput).text(),
  { from: styleInput },
);
const webRoot = path.resolve(import.meta.dirname, "../../../apps/web");
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const readerMessages = new Map<string, Map<string, string>>();
const localeRoot = path.join(webRoot, "src/i18n/langs");
for (const file of [
  ...new Bun.Glob("*.json").scanSync({ cwd: localeRoot }),
].toSorted()) {
  const locale = path.basename(file, ".json");
  const catalogue: unknown = await Bun.file(path.join(localeRoot, file)).json();
  const messages = new Map<string, string>();
  for (const key of [
    ...Object.values(READER_MESSAGE_KEYS),
    ...READER_TEMPLATE_KEYS,
  ]) {
    let value = catalogue;
    for (const segment of key.split(".")) {
      if (typeof value !== "object" || value === null) {
        panic(`Reader message ${key} is missing in ${locale}`);
      }
      value = Reflect.get(value, segment);
    }
    if (typeof value !== "string") {
      panic(`Reader message ${key} is missing in ${locale}`);
    }
    messages.set(key, value);
  }
  readerMessages.set(locale, messages);
}
await writeGenerated(
  path.join(generatedRoot, "reader-messages.json"),
  `${JSON.stringify(Object.fromEntries([...readerMessages].map(([locale, messages]) => [locale, Object.fromEntries(messages)])), null, 2)}\n`,
);

const inlineReaderFonts = {
  name: "inline-reader-fonts",
  setup(builder: Bun.PluginBuilder) {
    builder.onLoad(
      { filter: /source-serif-4\/.*\.css$/u },
      async ({ path: cssPath }) => {
        let contents = await Bun.file(cssPath).text();
        for (const match of [
          ...contents.matchAll(/url\(\s*["']?([^"'()\s]+)["']?\s*\)/gu),
        ]) {
          const url = match.at(1) ?? panic("Reader font URL has no path");
          if (url.startsWith("data:")) {
            continue;
          }
          if (!url.endsWith(".woff2")) {
            panic(`Unexpected shared reader font asset: ${url}`);
          }
          const bytes = await Bun.file(
            path.resolve(path.dirname(cssPath), url),
          ).arrayBuffer();
          contents = contents.replaceAll(
            match[0],
            () =>
              `url("data:font/woff2;base64,${Buffer.from(bytes).toBase64()}")`,
          );
        }
        return { contents, loader: "css" };
      },
    );
  },
} satisfies Bun.BunPlugin;
// The resource contract only allows data: fonts. UI text uses upright sans;
// legal-body emphasis uses the reader's separate serif face, not sans italics.
const fontStyles = postcss.parse(
  await Bun.file(path.join(webRoot, "src/fonts.css")).text(),
);
fontStyles.walkAtRules("font-face", (face) => {
  const italic = face.nodes?.some(
    (node) =>
      node.type === "decl" &&
      node.prop === "font-style" &&
      node.value === "italic",
  );
  if (italic) {
    face.remove();
  }
});
let fonts = fontStyles.toString();
const paths = [...fonts.matchAll(/url\("(\/fonts\/[^" ]+)"\)/gu)].map((match) =>
  match.at(1),
);
for (const fontPath of paths) {
  if (fontPath === undefined) {
    panic("Font URL has no path");
  }
  const bytes = await Bun.file(
    path.join(webRoot, "public", fontPath),
  ).arrayBuffer();
  fonts = fonts.replaceAll(
    `url("${fontPath}")`,
    () => `url("data:font/woff2;base64,${Buffer.from(bytes).toBase64()}")`,
  );
}
await writeGenerated(
  path.join(generatedRoot, "style.css"),
  `${fonts}\n${styles.css}`,
);

if (Bun.argv.includes("--shared-assets-only")) {
  process.exit(0);
}

const appsRoot = path.resolve(import.meta.dirname, "../src");
const sharedOutputRoot = path.join(appsRoot, "generated");
const PRODUCTION = { "process.env.NODE_ENV": JSON.stringify("production") };
// The shared runtime publishes the modules apps import from it here.
const RUNTIME_MODULES = 'globalThis[Symbol.for("stll.mcp-apps.runtime")]';
const SHARED_IMPORT = "stll-mcp-shared:";
const ENTRY_IMPORT = "stll-mcp-entry:";
const isStylesheet = (file: string) => file.endsWith(".css");

const build = async (label: string, config: Bun.BuildConfig) => {
  const result = await Bun.build({ ...config, throw: false });
  if (!result.success) {
    const messages = result.logs.map(({ message }) => message).join("\n");
    panic(messages || `${label} failed without a diagnostic`);
  }
  return {
    outputs: result.outputs,
    metafile:
      result.metafile ?? panic(`${label} did not report reachable inputs`),
  };
};

const onlyOutput = async (
  label: string,
  outputs: readonly Bun.BuildArtifact[],
  extension: ".css" | ".js",
): Promise<string> => {
  const matching = outputs.filter(({ path: file }) => file.endsWith(extension));
  const [output] = matching;
  if (matching.length !== 1 || output === undefined) {
    panic(`${label} emitted ${matching.length} ${extension} outputs`);
  }
  return await output.text();
};

/** Entry modules written by this script, so no temporary file is needed. */
const entryModules = new Map<string, string>();
const entryModulePlugin = {
  name: "mcp-entry-modules",
  setup(builder: Bun.PluginBuilder) {
    builder.onResolve(
      { filter: new RegExp(`^${ENTRY_IMPORT}`, "u") },
      ({ path: specifier }) => ({ path: specifier, namespace: "mcp-entry" }),
    );
    builder.onLoad(
      { filter: /.*/u, namespace: "mcp-entry" },
      ({ path: specifier }) => ({
        contents:
          entryModules.get(specifier) ??
          panic(`Unknown MCP entry module ${specifier}`),
        loader: "js",
      }),
    );
  },
} satisfies Bun.BunPlugin;

type ModuleImport = { specifier: string; file: string };
type ModuleGraph = {
  /** Every module the build read, by absolute path, with its imports in source order. */
  imports: ReadonlyMap<string, readonly ModuleImport[]>;
  /** Modules with code in the emitted script. */
  included: ReadonlySet<string>;
};

// Bun reaches a package through its store link or its real directory; one
// spelling per file keeps the graphs and the plugin lookups comparable.
const canonicalFiles = new Map<string, string>();
const canonicalFile = (file: string): string => {
  const known = canonicalFiles.get(file);
  if (known !== undefined) {
    return known;
  }
  const canonical = existsSync(file) ? realpathSync(file) : file;
  canonicalFiles.set(file, canonical);
  return canonical;
};

const readModuleGraph = (metafile: Bun.BuildMetafile): ModuleGraph => {
  const script = Object.entries(metafile.outputs).filter(([file]) =>
    file.endsWith(".js"),
  );
  const [entry] = script;
  if (script.length !== 1 || entry === undefined) {
    panic(`An MCP app build emitted ${script.length} scripts; expected one`);
  }
  const inputs = new Set(
    Object.keys(metafile.inputs).map((file) =>
      canonicalFile(path.resolve(file)),
    ),
  );
  // Bun names a metafile path from the working directory, and an import
  // sometimes from its importer instead. A module that only re-exports can be
  // missing from the inputs; it still has a file.
  const resolveImport = (importer: string, target: string) => {
    const candidates = [
      path.resolve(target),
      path.resolve(path.dirname(importer), target),
    ].map(canonicalFile);
    return (
      candidates.find((file) => inputs.has(file)) ??
      candidates.find((file) => existsSync(file)) ??
      panic(`${importer} imports ${target}, which has no file`)
    );
  };
  return {
    imports: new Map(
      Object.entries(metafile.inputs).map(([key, { imports }]) => {
        const importer = path.resolve(key);
        return [
          canonicalFile(importer),
          imports
            // Inlined fonts are data URLs, and a shared module stays outside
            // an app build.
            .filter(
              ({ path: target, external }) =>
                external !== true && !target.startsWith("data:"),
            )
            .map(({ path: target, original }) => ({
              specifier: original ?? target,
              file: resolveImport(importer, target),
            })),
        ];
      }),
    ),
    included: new Set(
      Object.entries(entry[1].inputs)
        .filter(
          ([file, { bytesInOutput }]) =>
            bytesInOutput > 0 && !isStylesheet(file),
        )
        .map(([file]) => canonicalFile(path.resolve(file))),
    ),
  };
};

const MODULE_SCRIPT =
  /<script type="module" src="\.\/([\w-]+\.tsx)"><\/script>/gu;
const readAppShell = async (directory: string) => {
  const template = await Bun.file(
    path.join(appsRoot, directory, "app.html"),
  ).text();
  const scripts = [...template.matchAll(MODULE_SCRIPT)];
  const [script] = scripts;
  if (
    scripts.length !== 1 ||
    script === undefined ||
    template.match(/<script/giu)?.length !== 1
  ) {
    panic(`MCP app ${directory} must load exactly one module script`);
  }
  const page = template.replace(script[0], "");
  const head = page.indexOf("</head>");
  const body = page.indexOf("</body>");
  if (
    head === -1 ||
    body < head ||
    page.lastIndexOf("</head>") !== head ||
    page.lastIndexOf("</body>") !== body
  ) {
    panic(`MCP app ${directory} needs one head and one body`);
  }
  return {
    entry: path.join(
      appsRoot,
      directory,
      script[1] ?? panic(`MCP app ${directory} names no module`),
    ),
    shell: [
      page.slice(0, head),
      page.slice(head, body),
      page.slice(body),
    ] as const satisfies McpAppDocumentParts["shell"],
  };
};

/**
 * Stylesheets a script imports, in the order Bun cascades them: the first
 * import reached by a depth-first walk of the script's imports.
 */
const stylesheetRoots = (graph: ModuleGraph, entry: string): string[] => {
  const roots: string[] = [];
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    for (const { file: target } of graph.imports.get(file) ?? []) {
      if (!isStylesheet(target)) {
        visit(target);
      } else if (!roots.includes(target)) {
        roots.push(target);
      }
    }
  };
  visit(entry);
  return roots;
};

const readerInputGraphs = new Map<string, string[]>();
/**
 * Builds the app as one script, the way it would ship alone. The graph
 * decides what the apps share; the stylesheet is the cascade the split
 * stylesheets must reproduce.
 */
const analyseMcpApp = async (directory: McpAppDirectory) => {
  const app = `${directory}/app.html`;
  const { entry, shell } = await readAppShell(directory);
  const { outputs, metafile } = await build(`MCP app ${app}`, {
    root: repoRoot,
    metafile: true,
    plugins: [generatedAssetPlugin, reactCompilerBunPlugin, inlineReaderFonts],
    entrypoints: [entry],
    minify: true,
    define: PRODUCTION,
    target: "browser",
    format: "esm",
  });

  const developmentInputs = Object.keys(metafile.inputs).filter((file) =>
    /[/\\]react(?:-dom)?[/\\].*\.development\.js$/u.test(file),
  );
  if (developmentInputs.length > 0) {
    panic(
      `MCP app ${app} includes React development modules: ${developmentInputs.join(", ")}`,
    );
  }
  const apiInputs = Object.keys(metafile.inputs).filter((file) =>
    repoRelativePath(repoRoot, path.resolve(file)).startsWith("apps/api/"),
  );
  if (apiInputs.length > 0) {
    panic(`MCP app ${app} reaches API source: ${apiInputs.join(", ")}`);
  }

  const readerDirectory = MCP_READER_UI_APP_DIRECTORIES.find(
    (name) => name === directory,
  );
  if (readerDirectory !== undefined) {
    const inputs = Object.keys(metafile.inputs)
      .map((file) => repoRelativePath(repoRoot, path.resolve(file)))
      .filter((file) => /^(?:apps|packages)\//u.test(file))
      .toSorted();
    const loadModule = async (file: string) => ({
      file,
      text: await Bun.file(path.join(repoRoot, file)).text(),
    });
    const sharedFiles = Object.values(readerPackage.exports)
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => `packages/decision-reader/${file.replace(/^\.\//u, "")}`);
    const [sharedModules, astModules, bundleModules] = await Promise.all([
      Promise.all(sharedFiles.map(loadModule)),
      Promise.all(
        [
          "packages/legal-ast/src/document-ast.ts",
          "packages/legal-ast/src/inline.ts",
        ].map(loadModule),
      ),
      Promise.all(
        inputs
          .filter(
            (file) =>
              /\.[cm]?[jt]sx?$/u.test(file) &&
              /^(?:apps|packages)\//u.test(file),
          )
          .map(loadModule),
      ),
    ]);
    const readerIssues = inspectMcpReaderUi({
      sharedModules,
      astModules,
      bundleModules,
    });
    if (readerIssues.length > 0) {
      panic(
        `MCP app ${app} duplicates shared reader UI: ${readerIssues.join(", ")}`,
      );
    }
    readerInputGraphs.set(readerDirectory, inputs);
  }

  const graph = readModuleGraph(metafile);
  return {
    directory,
    entry,
    shell,
    graph,
    stylesheet: outputs.some(({ path: file }) => file.endsWith(".css"))
      ? await onlyOutput(`MCP app ${app}`, outputs, ".css")
      : "",
    stylesheets: stylesheetRoots(graph, canonicalFile(entry)),
  };
};

const apps = await Promise.all(
  MCP_APPS.map(({ directory }) => directory).map(analyseMcpApp),
);

// Bun resolves an import the same way in every build with the same options,
// so the analysis tells the split builds where each import lands.
const resolutions = new Map<string, string>();
for (const { graph } of apps) {
  for (const [importer, imports] of graph.imports) {
    for (const { specifier, file } of imports) {
      const key = `${importer}\0${specifier}`;
      const known = resolutions.get(key);
      if (known !== undefined && known !== file) {
        panic(`${specifier} from ${importer} resolves to ${known} and ${file}`);
      }
      resolutions.set(key, file);
    }
  }
}

// A stable name for a shared module that does not depend on where the
// package store lives on this machine.
const moduleIds = new Map<string, string>();
const moduleId = (file: string): string => {
  const marker = file.lastIndexOf("/node_modules/");
  const id =
    marker === -1
      ? repoRelativePath(repoRoot, file)
      : file.slice(marker + "/node_modules/".length);
  const known = moduleIds.get(id);
  if (known !== undefined && known !== file) {
    panic(`Shared modules ${known} and ${file} share the name ${id}`);
  }
  moduleIds.set(id, file);
  return id;
};

const escapeRegExp = (text: string) =>
  text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&");
const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|css)$/u;

/**
 * A resolve hook that matches every import stops Bun from skipping the unused
 * re-exports of side-effect-free barrels, which grew each app by about a
 * third. The hook therefore matches only the imports that can land on a
 * module it takes over: those the analysis recorded, and relative imports by
 * file name, because the analysis holds no record of what a skipped barrel
 * imports.
 */
const splitFilter = (targets: ReadonlySet<string>): RegExp => {
  const specifiers = new Set<string>();
  for (const [key, file] of resolutions) {
    if (targets.has(file)) {
      specifiers.add(key.slice(key.indexOf("\0") + 1));
    }
  }
  const names = new Set(
    [...targets].map((file) =>
      path.basename(file).replace(MODULE_EXTENSION, ""),
    ),
  );
  return new RegExp(
    `^(?:${[...specifiers].map(escapeRegExp).join("|")})$|^\\.\\.?/(?:.*/)?(?:${[...names].map(escapeRegExp).join("|")})(?:\\.[\\w]+)?$`,
    "u",
  );
};

const resolveAnalysed = (
  importer: string,
  specifier: string,
): string | undefined => {
  const file = canonicalFile(importer);
  const known = resolutions.get(`${file}\0${specifier}`);
  if (known !== undefined || !/^\.\.?\//u.test(specifier)) {
    return known;
  }
  // A relative import resolves the same way in any build.
  const resolved = Result.try(() =>
    Bun.resolveSync(specifier, path.dirname(file)),
  );
  return resolved.isOk() ? canonicalFile(resolved.value) : undefined;
};

const stylesheetFiles = new Set(
  apps.flatMap(({ graph }) => [...graph.imports.keys()].filter(isStylesheet)),
);

/**
 * Stylesheets are assembled separately, and a shared module is read from the
 * runtime: both leave the script build.
 */
const splitPlugin = (shared: ReadonlySet<string>) =>
  ({
    name: "mcp-split",
    setup(builder: Bun.PluginBuilder) {
      const filter = splitFilter(shared.union(stylesheetFiles));
      builder.onResolve({ filter }, ({ path: specifier, importer }) => {
        const file = resolveAnalysed(importer, specifier);
        if (file === undefined) {
          return undefined;
        }
        if (isStylesheet(file)) {
          return { path: file, namespace: "mcp-stylesheet" };
        }
        if (shared.has(file)) {
          return { path: `${SHARED_IMPORT}${moduleId(file)}`, external: true };
        }
        return undefined;
      });
      builder.onLoad({ filter: /.*/u, namespace: "mcp-stylesheet" }, () => ({
        contents: "",
        loader: "js",
      }));
    },
  }) satisfies Bun.BunPlugin;

const scriptBuild = (shared: ReadonlySet<string>) =>
  ({
    root: repoRoot,
    metafile: true,
    plugins: [
      entryModulePlugin,
      splitPlugin(shared),
      generatedAssetPlugin,
      reactCompilerBunPlugin,
    ],
    define: PRODUCTION,
    target: "browser",
  }) satisfies Omit<Bun.BuildConfig, "entrypoints">;

/** An import of a shared module in an app script. */
type SharedImport = {
  start: number;
  end: number;
  id: string;
  /** Named and default imports as [exported name, local name]. */
  bindings: (readonly [string, string])[];
  /**
   * Namespace imports with the members the app reads, or none when the app
   * uses the namespace object itself.
   */
  namespaces: { local: string; members: ReadonlySet<string> | undefined }[];
};

const buildAppScript = async (
  app: (typeof apps)[number],
  shared: ReadonlySet<string>,
) => {
  const label = `MCP app ${app.directory}/app.html`;
  const { outputs, metafile } = await build(label, {
    ...scriptBuild(shared),
    entrypoints: [app.entry],
    format: "esm",
    // Identifiers stay as written until the app is linked to the runtime,
    // so a namespace import can be traced to the members it reads.
    minify: { whitespace: true, syntax: true, identifiers: false },
  });
  const code = await onlyOutput(label, outputs, ".js");
  const { module, program } = parseSource("app.js", code);
  const namespaceLocals = new Set(
    module.staticImports.flatMap(({ entries }) =>
      entries
        .filter(({ importName }) => importName.kind === "NamespaceObject")
        .map(({ localName }) => localName.value),
    ),
  );
  const members = namespaceMembers(program, namespaceLocals);
  const imports = module.staticImports.map(
    ({ start, end, moduleRequest, entries }): SharedImport => {
      if (!moduleRequest.value.startsWith(SHARED_IMPORT)) {
        panic(`${label} imports ${moduleRequest.value} at runtime`);
      }
      const id = moduleRequest.value.slice(SHARED_IMPORT.length);
      return {
        start,
        end,
        id,
        bindings: entries
          .filter(({ importName }) => importName.kind !== "NamespaceObject")
          .map(
            ({ importName, localName }) =>
              [
                importName.kind === "Default"
                  ? "default"
                  : (importName.name ??
                    panic(`An import from ${id} has no name`)),
                localName.value,
              ] as const,
          ),
        namespaces: entries
          .filter(({ importName }) => importName.kind === "NamespaceObject")
          .map(({ localName }) => ({
            local: localName.value,
            members: members.get(localName.value),
          })),
      };
    },
  );
  const { included } = readModuleGraph(metafile);
  const bundledShared = [...included.intersection(shared)];
  if (bundledShared.length > 0) {
    panic(
      `${label} bundles modules the runtime provides: ${bundledShared.join(", ")}`,
    );
  }
  return { label, code, imports, included };
};

type RuntimeExports = { namespace: boolean; names: Set<string> };

const runtimeEntry = (exposed: readonly [string, RuntimeExports][]): string => {
  const lines: string[] = [];
  const values: string[] = [];
  for (const [index, [id, { namespace, names }]] of exposed.entries()) {
    const source = JSON.stringify(
      moduleIds.get(id) ?? panic(`Unknown shared module ${id}`),
    );
    if (namespace) {
      lines.push(`import * as m${index} from ${source};`);
      values.push(`m${index}`);
      continue;
    }
    const bindings = [...names]
      .toSorted()
      .map((name, binding) => [JSON.stringify(name), `m${index}_${binding}`]);
    lines.push(
      bindings.length === 0
        ? `import ${source};`
        : `import { ${bindings.map(([name, local]) => `${name} as ${local}`).join(", ")} } from ${source};`,
    );
    values.push(
      `{ ${bindings.map(([name, local]) => `${name}: ${local}`).join(", ")} }`,
    );
  }
  lines.push(`${RUNTIME_MODULES} = [${values.join(", ")}];`);
  return lines.join("\n");
};

/**
 * Reads each shared import from the runtime instead of an import statement,
 * then minifies the app as one script.
 */
const linkAppScript = async (
  { label, code, imports }: Awaited<ReturnType<typeof buildAppScript>>,
  indexes: ReadonlyMap<string, number>,
): Promise<string> => {
  const declarations: string[] = [];
  let body = "";
  let position = 0;
  for (const { start, end, id, bindings, namespaces } of imports.toSorted(
    (left, right) => left.start - right.start,
  )) {
    body += code.slice(position, start);
    position = end;
    const runtimeModule = `${RUNTIME_MODULES}[${indexes.get(id) ?? panic(`Shared module ${id} is not in the runtime`)}]`;
    for (const { local } of namespaces) {
      declarations.push(`const ${local} = ${runtimeModule};`);
    }
    if (bindings.length > 0) {
      declarations.push(
        `const { ${bindings.map(([name, local]) => `${JSON.stringify(name)}: ${local}`).join(", ")} } = ${runtimeModule};`,
      );
    }
  }
  const linked = [...declarations, body + code.slice(position)].join("\n");
  // Bun names a module's namespace object `exports_<name>`; one that is used
  // but never declared means a bundled module re-exports a shared one.
  const declaredNamespaces = new Set(
    [...linked.matchAll(/\bvar (exports_\w+)/gu)].map(([, name]) => name),
  );
  const undeclared = [
    ...new Set(
      [...linked.matchAll(/\b(exports_\w+)\b/gu)]
        .map(([, name]) => name)
        .filter((name) => !declaredNamespaces.has(name)),
    ),
  ];
  if (undeclared.length > 0) {
    panic(`${label} uses undeclared namespaces: ${undeclared.join(", ")}`);
  }
  if (linked.includes(SHARED_IMPORT)) {
    panic(
      `${label} loads a shared module without a static import; the runtime cannot provide it`,
    );
  }
  const entry = `${ENTRY_IMPORT}${label}`;
  entryModules.set(entry, linked);
  const { outputs } = await build(label, {
    root: repoRoot,
    metafile: true,
    plugins: [entryModulePlugin],
    entrypoints: [entry],
    format: "esm",
    minify: true,
    target: "browser",
  });
  return await onlyOutput(label, outputs, ".js");
};

// Modules Bun skipped while analysing, imported but never read: unused
// modules, and barrels whose re-exports Bun followed past them.
const analysedModules = new Set(
  apps.flatMap(({ graph }) => [...graph.imports.keys()]),
);
const skippedBarrels = new Set(
  [...resolutions.values()].filter(
    (file) =>
      !analysedModules.has(file) && !isStylesheet(file) && existsSync(file),
  ),
);
const barrelTargets = new Map<string, string[]>();
const readBarrelTargets = async (barrel: string): Promise<string[]> => {
  const known = barrelTargets.get(barrel);
  if (known !== undefined) {
    return known;
  }
  const { module, program } = parseSource(
    barrel,
    await Bun.file(barrel).text(),
  );
  // A module with code of its own is not a barrel; Bun skipped it as unused.
  const reExportsOnly = program.body.every(
    (statement) =>
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportAllDeclaration" ||
      (statement.type === "ExportNamedDeclaration" &&
        statement.declaration === null),
  );
  if (!reExportsOnly) {
    barrelTargets.set(barrel, []);
    return [];
  }
  const targets = [
    ...module.staticImports.map(({ moduleRequest }) => moduleRequest.value),
    ...module.staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest }) =>
        moduleRequest === null ? [] : [moduleRequest.value],
      ),
    ),
  ].flatMap((specifier) => resolveAnalysed(barrel, specifier) ?? []);
  barrelTargets.set(barrel, targets);
  return targets;
};

/**
 * A skipped barrel that re-exports a shared module is shared too. Bundled
 * into an app, it would refer to a namespace object that Bun never emits
 * once its target is external.
 */
const withSharedBarrels = async (
  shared: ReadonlySet<string>,
): Promise<ReadonlySet<string>> => {
  const result = new Set(shared);
  for (let size = -1; size !== result.size;) {
    size = result.size;
    for (const barrel of skippedBarrels) {
      if (
        !result.has(barrel) &&
        (await readBarrelTargets(barrel)).some((file) => result.has(file))
      ) {
        result.add(barrel);
      }
    }
  }
  return result;
};

/**
 * Splits the apps into one runtime of the modules every app includes and one
 * script per app. A module that only the runtime's copy of a shared module
 * keeps joins the runtime too, so no module runs twice.
 */
const splitScripts = async () => {
  let shared: ReadonlySet<string> = new Set(apps.at(0)?.graph.included);
  for (const { graph } of apps) {
    shared = shared.intersection(graph.included);
  }
  shared = await withSharedBarrels(shared);
  for (let round = 1; ; round += 1) {
    const roundShared = shared;
    const scripts = await Promise.all(
      apps.map(async (app) => await buildAppScript(app, roundShared)),
    );
    const exposed = new Map<string, RuntimeExports>();
    for (const { id, bindings, namespaces } of scripts.flatMap(
      ({ imports }) => imports,
    )) {
      const used = exposed.get(id) ?? { namespace: false, names: new Set() };
      for (const [name] of bindings) {
        used.names.add(name);
      }
      for (const { members } of namespaces) {
        if (members === undefined) {
          used.namespace = true;
        } else {
          for (const member of members) {
            used.names.add(member);
          }
        }
      }
      exposed.set(id, used);
    }
    const runtimeExports = [...exposed].toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    entryModules.set(`${ENTRY_IMPORT}runtime`, runtimeEntry(runtimeExports));
    const runtime = await build("MCP app runtime", {
      ...scriptBuild(new Set()),
      entrypoints: [`${ENTRY_IMPORT}runtime`],
      format: "iife",
      minify: true,
    });
    const runtimeIncluded = readModuleGraph(runtime.metafile).included;
    const duplicated = new Set(
      scripts.flatMap(({ included }) => [
        ...included.intersection(runtimeIncluded),
      ]),
    );
    if (duplicated.size === 0) {
      const indexes = new Map(
        runtimeExports.map(([id], index) => [id, index] as const),
      );
      return {
        runtime: await onlyOutput("MCP app runtime", runtime.outputs, ".js"),
        scripts: await Promise.all(
          scripts.map(async (script) => await linkAppScript(script, indexes)),
        ),
      };
    }
    if (round === 4) {
      panic(
        `MCP app scripts still duplicate runtime modules: ${[...duplicated].join(", ")}`,
      );
    }
    shared = await withSharedBarrels(shared.union(duplicated));
  }
};

const buildStylesheet = async (
  label: string,
  stylesheets: readonly string[],
): Promise<string> => {
  if (stylesheets.length === 0) {
    return "";
  }
  const entry = `${ENTRY_IMPORT}${label}`;
  entryModules.set(
    entry,
    stylesheets.map((file) => `import ${JSON.stringify(file)};`).join("\n"),
  );
  const { outputs } = await build(label, {
    root: repoRoot,
    metafile: true,
    plugins: [entryModulePlugin, generatedAssetPlugin, inlineReaderFonts],
    entrypoints: [entry],
    minify: true,
    target: "browser",
  });
  // A single build joins its stylesheets without the final newline each
  // separate build ends with.
  return (await onlyOutput(label, outputs, ".css")).trimEnd();
};

/**
 * The stylesheets every app imports are stored once. The cascade is the
 * app's own: its other stylesheets go before or after the shared ones, as
 * they were imported, and the result must equal the single-script build.
 */
const splitStylesheets = async () => {
  let shared = apps.at(0)?.stylesheets ?? [];
  for (const { stylesheets } of apps) {
    shared = shared.filter((file) => stylesheets.includes(file));
  }
  const runtime = await buildStylesheet("runtime-stylesheet", shared);
  const appStyles = await Promise.all(
    apps.map(async ({ directory, stylesheets, stylesheet }) => {
      const own = stylesheets.filter((file) => !shared.includes(file));
      const sharedFirst = stylesheets.at(0) === shared.at(0);
      const order = sharedFirst ? [...shared, ...own] : [...own, ...shared];
      if (order.some((file, index) => stylesheets[index] !== file)) {
        panic(
          `MCP app ${directory} interleaves its stylesheets with the shared ones: ${stylesheets.join(", ")}`,
        );
      }
      const appStylesheet = await buildStylesheet(
        `${directory}-stylesheet`,
        own,
      );
      const cascade = (
        sharedFirst ? [runtime, appStylesheet] : [appStylesheet, runtime]
      ).filter((style) => style !== "");
      if (cascade.join("") !== stylesheet.trimEnd()) {
        panic(`MCP app ${directory} stylesheets do not reproduce its cascade`);
      }
      return { own: appStylesheet, sharedFirst };
    }),
  );
  return { runtime, styles: appStyles };
};

// `</script` or `</style` inside the text would end the element early. The
// escaped form means the same in a JavaScript or CSS string, and minified
// code has it nowhere else.
const escapeElementText = (text: string, element: "script" | "style") =>
  text.replaceAll(new RegExp(`</(${element})`, "giu"), "<\\/$1");

const [scriptParts, stylesheetParts] = await Promise.all([
  splitScripts(),
  splitStylesheets(),
]);
const runtimeScript = escapeElementText(scriptParts.runtime, "script");
const runtimeStyle = escapeElementText(stylesheetParts.runtime, "style");
await writeGenerated(
  path.join(sharedOutputRoot, "runtime.js.txt"),
  runtimeScript,
);
await writeGenerated(
  path.join(sharedOutputRoot, "runtime.css.txt"),
  runtimeStyle,
);

const documentParts = await Promise.all(
  apps.map(async ({ directory, shell }, index) => {
    const { own, sharedFirst } =
      stylesheetParts.styles[index] ?? panic(`No stylesheet for ${directory}`);
    const appStyle = escapeElementText(own, "style");
    const appScript = escapeElementText(
      scriptParts.scripts[index] ?? panic(`No script for ${directory}`),
      "script",
    );
    // Each style with the name bundles.ts imports it under.
    const sharedEntry = ["runtimeStyle", runtimeStyle] as const;
    const appEntry = [`style${index}`, appStyle] as const;
    const styleParts = (
      sharedFirst ? [sharedEntry, appEntry] : [appEntry, sharedEntry]
    ).filter(([, style]) => style !== "");
    const parts = {
      shell,
      styles: styleParts.map(([, style]) => style),
      scripts: [runtimeScript],
      module: appScript,
    } satisfies McpAppDocumentParts;
    const html = assembleMcpAppDocument(parts);
    const issues = [
      ...inspectMcpAppHtml(html),
      ...inspectMcpAppDocument(html, parts),
    ];
    if (issues.length > 0) {
      panic(
        `MCP app build for ${directory}/app.html is not self-contained: ${issues.join(", ")}`,
      );
    }
    const generated = path.join(appsRoot, directory, "generated");
    await Promise.all([
      writeGenerated(path.join(generated, "app.js.txt"), appScript),
      writeGenerated(path.join(generated, "app.css.txt"), appStyle),
      // The served document, for tests and budgets that read one file.
      writeGenerated(path.join(generated, "app.html.txt"), html),
    ]);
    return {
      directory,
      shell,
      styles: styleParts.map(([name]) => name),
      hasStyle: appStyle !== "",
    };
  }),
);

const readerGraphs = Object.fromEntries(
  MCP_READER_UI_APP_DIRECTORIES.map((directory) => [
    directory,
    readerInputGraphs.get(directory) ??
      panic(`MCP reader graph was not built for ${directory}`),
  ]),
);
await writeGenerated(
  path.join(generatedRoot, "reader-inputs.json"),
  `${JSON.stringify(readerGraphs, null, 2)}\n`,
);

await writeGenerated(
  path.join(sharedOutputRoot, "bundles.ts"),
  [
    "// Generated by build-mcp-apps.ts; do not edit.",
    'import type { McpAppDocumentParts } from "../app-document";',
    'import type { McpAppDirectory } from "../manifest";',
    'import runtimeScript from "./runtime.js.txt" with { type: "text" };',
    'import runtimeStyle from "./runtime.css.txt" with { type: "text" };',
    ...documentParts.flatMap(({ directory, hasStyle }, index) => [
      `import script${index} from "../${directory}/generated/app.js.txt" with { type: "text" };`,
      ...(hasStyle
        ? [
            `import style${index} from "../${directory}/generated/app.css.txt" with { type: "text" };`,
          ]
        : []),
    ]),
    "",
    "export const MCP_APP_DOCUMENT_PARTS = {",
    ...documentParts.map(
      ({ directory, shell, styles: styleNames }, index) =>
        `  "${directory}": { shell: ${JSON.stringify(shell)}, styles: [${styleNames.join(", ")}], scripts: [runtimeScript], module: script${index} },`,
    ),
    "} as const satisfies Record<McpAppDirectory, McpAppDocumentParts>;",
    "",
  ].join("\n"),
);

if (checking) {
  console.log(
    `Checked ${MCP_APPS.length} MCP app bundles without writing outputs`,
  );
  process.exit(0);
}

const artifacts = await formattedArtifactsLikeRepository(
  await Promise.all(
    [
      ...[
        "messages.json",
        "reader-messages.json",
        "reader-inputs.json",
        "style.css",
      ].map((file) => path.join(generatedRoot, file)),
      path.join(sharedOutputRoot, "bundles.ts"),
    ].map(async (file) => ({
      path: file,
      contents: await Bun.file(file).text(),
    })),
  ),
);
await Promise.all(
  artifacts.map(
    async ({ path: file, contents }) => await writeGenerated(file, contents),
  ),
);
