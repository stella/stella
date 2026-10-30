// Fonts Metro bundles as assets; importing one gives its asset id.
declare module "*.ttf" {
  const asset: number;
  export default asset;
}
