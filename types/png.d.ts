/**
 * PNG assets imported with `with { type: "file" }` (the API host's icon).
 * Same contract as `docx.d.ts`: the import evaluates to a readable path, in
 * the source tree or beside the bundled server.
 */
declare module "*.png" {
  const path: string;
  export default path;
}
