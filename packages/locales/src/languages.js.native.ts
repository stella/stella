// Metro treats an explicit `.js` import as a literal source suffix, unlike
// TypeScript's bundler resolution. Bridge the strict ESM specifier used by the
// package sources to the native TypeScript module without duplicating data.
export * from "./languages";
