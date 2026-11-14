// @stll/oxlint-config's stella-lowercase plugin, loaded through an ES import.
// Bun's linter resolves a package specifier in `jsPlugins` with the package's
// `require` export and does not unwrap that build's default export, so it
// finds no plugin under `@stll/oxlint-config/plugin`. A local module that
// re-exports the plugin loads the same rules under oxlint and Bun alike.
export { default } from "@stll/oxlint-config/plugin";
