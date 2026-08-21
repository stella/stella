/**
 * Markdown assets imported with `with { type: "file" }` (report spec prompts).
 * Same contract as `docx.d.ts`: the import evaluates to a readable path, in
 * the source tree or inside the compiled binary's embedded assets.
 */
declare module "*.md" {
  const path: string;
  export default path;
}
