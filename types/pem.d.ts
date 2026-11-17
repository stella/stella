/**
 * PEM certificate bundles imported with `with { type: "file" }` (the
 * qualified timestamp trust anchors). Same contract as `docx.d.ts`: the
 * import evaluates to a readable path, in the source tree or inside the
 * compiled binary's embedded assets.
 */
declare module "*.pem" {
  const path: string;
  export default path;
}
