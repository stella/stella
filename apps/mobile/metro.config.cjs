// Metro's settings for the app: Expo's defaults, plus one resolution rule.
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

config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    context,
    typeScriptSourceOf(context.originModulePath, moduleName) ?? moduleName,
    platform,
  );

// Tailwind classes, compiled to native styles, over the web's tokens.
module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});
