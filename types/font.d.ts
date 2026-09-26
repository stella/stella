/**
 * Font assets imported with `with { type: "file" }` (the signature stamp's
 * font). Same contract as `docx.d.ts`: the import evaluates to a readable
 * path, in the source tree or inside the compiled binary's embedded assets.
 */
declare module "*.ttf" {
  const path: string;
  export default path;
}
