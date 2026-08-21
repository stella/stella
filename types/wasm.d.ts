/**
 * WASM assets imported through Bun's `file` loader. The import evaluates to
 * the source file's path in development and an embedded `/$bunfs` path in a
 * compiled executable.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}
