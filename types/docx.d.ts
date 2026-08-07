/**
 * DOCX assets imported with `with { type: "file" }`. The import evaluates to a
 * path the Bun runtime can read: the file's own location when the source runs
 * directly, and a path inside the embedded asset directory once `bun build
 * --compile` links it into the server binary.
 *
 * This declaration lives in the shared types directory because the web
 * typecheck follows the API route types through its `@/api/*` path alias.
 */
declare module "*.docx" {
  const path: string;
  export default path;
}
