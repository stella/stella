/**
 * ICC colour profiles imported with `with { type: "file" }` (the PDF/A
 * output intent). Same contract as `docx.d.ts`: the import evaluates to a
 * readable path, in the source tree or inside the compiled binary's
 * embedded assets.
 */
declare module "*.icc" {
  const path: string;
  export default path;
}
