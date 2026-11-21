/**
 * Typst templates imported with `with { type: "file" }` (the invoice
 * renderer's default template). Same contract as `docx.d.ts`: the import
 * evaluates to a readable path, in the source tree or inside the compiled
 * binary's embedded assets.
 */
declare module "*.typ" {
  const path: string;
  export default path;
}
