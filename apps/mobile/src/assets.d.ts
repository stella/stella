// Fonts Metro bundles as assets; importing one gives its asset id.
declare module "*.ttf" {
  const asset: number;
  export default asset;
}

// Fonts the document viewer's web bundle declares itself: there, importing
// one gives the URL Metro serves it at.
declare module "*.woff2" {
  const asset: string | { uri: string } | number;
  export default asset;
}
