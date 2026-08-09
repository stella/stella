// Passive regression fixture for `no-object-url-leak/no-object-url-leak`.
//
// Rule-specific disables mark creations the rule MUST reject. If detection
// regresses, unused-directive reporting fails this fixture. Unannotated calls
// cover the supported local disposal and shadowing patterns.

declare const blob: Blob;
declare const condition: boolean;

// MUST flag: an escaped Blob URL has no visible owner or cleanup.
export const escapedUrl = () =>
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: returned Blob URL has no local revocation
  URL.createObjectURL(blob);

// MUST flag: binding the result without revoking it still pins the Blob.
export const retainedUrl = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: local Blob URL is never revoked
  const url = URL.createObjectURL(blob);
  return url;
};

// MUST flag: explicit globalThis access is the same browser API.
export const explicitGlobalUrl = () => {
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: explicit global namespace cannot bypass disposal
  globalThis.URL.createObjectURL(blob);
};

// MUST flag: revoking an earlier value does not dispose a later assignment.
export const revokeBeforeCreate = () => {
  let url = "blob:old";
  URL.revokeObjectURL(url);
  // oxlint-disable-next-line no-object-url-leak/no-object-url-leak -- fixture: revocation precedes this creation
  url = URL.createObjectURL(blob);
  return url;
};

// Allowed: direct local pairing with the same binding.
export const downloadUrl = () => {
  const url = URL.createObjectURL(blob);
  URL.revokeObjectURL(url);
};

// Allowed: immutable aliases preserve the same produced value.
export const aliasedCleanup = () => {
  const url = window.URL.createObjectURL(blob);
  const cleanupUrl = url;
  window.URL.revokeObjectURL(cleanupUrl);
};

// Allowed: a returned cleanup callback closes over the created URL.
export const cleanupCallback = () => {
  const url = URL.createObjectURL(blob);
  return () => URL.revokeObjectURL(url);
};

// Allowed: conditional creation has one ownership write and revokes whichever
// branch produced the value.
export const conditionalCleanup = () => {
  const url = condition
    ? URL.createObjectURL(blob)
    : globalThis.URL.createObjectURL(blob);
  URL.revokeObjectURL(url);
};

// Allowed: immediate create/revoke is unusual but does not retain the Blob.
export const immediateCleanup = () =>
  URL.revokeObjectURL(URL.createObjectURL(blob));

// Allowed: locally injected URL-shaped objects are not the browser global.
export const useInjectedUrl = (URL: {
  createObjectURL: (value: Blob) => string;
}) => URL.createObjectURL(blob);

// Allowed: a locally injected window is not the browser global host.
export const useInjectedWindow = (window: {
  URL: { createObjectURL: (value: Blob) => string };
}) => window.URL.createObjectURL(blob);
