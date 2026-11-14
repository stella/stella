// The fetch classes React Native installs on a phone (`whatwg-fetch`, which
// ships no types), typed as the standard ones they stand in for.
declare module "whatwg-fetch" {
  export const Headers: typeof globalThis.Headers;
  export const Request: typeof globalThis.Request;
  export const Response: typeof globalThis.Response;
}
