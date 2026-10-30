// Metro's settings for the app: Expo's defaults, plus two resolution rules
// and the document viewer's font files.
//
// The workspace packages the app imports are TypeScript written for Node's
// ESM resolution, so their relative imports name the emitted `.js` file
// (`./languages.js` for `languages.ts`). Bun and TypeScript map that back to
// the source; Metro does not, so such an import resolves to the `.ts` file
// beside it when one exists. Packages under node_modules ship real `.js`
// files and keep Metro's own resolution.
const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);
// Bun can link Metro's runtime outside the checkout. Its empty module must
// be visible to the file map even when no import traverses that symlink.
config.watchFolders.push(path.dirname(config.resolver.emptyModulePath));
const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

const typeScriptSourceOf = (originModulePath, moduleName) => {
  if (
    !moduleName.startsWith(".") ||
    !moduleName.endsWith(".js") ||
    originModulePath.includes(NODE_MODULES)
  ) {
    return undefined;
  }
  const source = `${moduleName.slice(0, -".js".length)}.ts`;
  return fs.existsSync(path.resolve(path.dirname(originModulePath), source))
    ? source
    : undefined;
};

// The document viewer bundles the faces folio lays documents out in
// (src/components/document-viewer/folio-fonts.gen.ts). They come from
// fontsource packages folio itself depends on, so they resolve from folio's
// own location: the versions are the ones folio's stylesheet was built for.
const FOLIO_STYLESHEET = require.resolve("@stll/folio-react/editor.css", {
  paths: [__dirname],
});

config.resolver.resolveRequest = (context, moduleName, platform) =>
  moduleName.startsWith("@fontsource/")
    ? context.resolveRequest(
        { ...context, originModulePath: FOLIO_STYLESHEET },
        moduleName,
        platform,
      )
    : context.resolveRequest(
        context,
        typeScriptSourceOf(context.originModulePath, moduleName) ?? moduleName,
        platform,
      );

if (!config.resolver.assetExts.includes("woff2")) {
  config.resolver.assetExts.push("woff2");
}

// Tailwind classes, compiled to native styles, over the web's tokens.
module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.gen.d.ts",
});
