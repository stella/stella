// Passive regression fixture for
// `no-auth-token-in-web-storage/no-auth-token-in-web-storage`.
//
// Rule-specific disables mark writes the rule MUST reject. If detection
// regresses, unused-directive reporting fails this fixture. Unannotated writes
// cover the intentional false-positive boundaries.

declare const credential: string;
declare const dynamicKey: string;
declare const getTokenKey: () => string;
declare const setItem: keyof Storage;

const ACCESS_TOKEN_KEY = "access_token";
const ID_TOKEN_KEY = "id_token";
const SET_ITEM_METHOD = "setItem";
let mutableTokenKey = "access_token";

// MUST flag: direct localStorage.setItem with a credential-like literal key.
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage -- fixture: browser-readable access token
localStorage.setItem("accessToken", credential);

// MUST flag: sessionStorage reached through window.
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage -- fixture: explicit browser-global storage
window.sessionStorage.setItem("refresh-token", credential);

// MUST flag: a const static key preserves its credential meaning.
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage -- fixture: const key indirection cannot bypass the rule
globalThis.localStorage.setItem(ACCESS_TOKEN_KEY, credential);

// MUST flag: stable aliases preserve the browser storage provenance.
const aliasedStorage = window.localStorage;
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage -- fixture: a const alias cannot bypass the storage boundary
aliasedStorage.setItem("accessToken", credential);

// MUST flag: static bracket notation for the storage and method.
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage, typescript/dot-notation -- fixture: static bracket notation is the same storage sink
window["localStorage"]["setItem"]("jwt", credential);

// MUST flag: property assignment is also a storage write.
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage -- fixture: property assignment persists the credential
sessionStorage.authToken = credential;

// MUST flag: computed static property assignment.
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage, typescript/dot-notation -- fixture: computed property cannot bypass the rule
globalThis.sessionStorage["private_key"] = credential;

// MUST flag: a static template key is equivalent to a string literal.
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage, typescript/dot-notation -- fixture: a static template remains a known credential key
sessionStorage[`refreshToken`] = credential;

// MUST flag: a const-bound computed key remains statically resolvable.
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage -- fixture: const key aliases cannot bypass assignment detection
localStorage[ID_TOKEN_KEY] = credential;

// MUST flag: a const-bound computed method preserves the setItem sink.
// oxlint-disable-next-line no-auth-token-in-web-storage/no-auth-token-in-web-storage -- fixture: const method aliases cannot bypass setItem detection
localStorage[SET_ITEM_METHOD]("accessToken", credential);

// Allowed: ordinary preferences and deliberately JavaScript-readable CSRF or
// push tokens are not authentication credentials.
localStorage.setItem("theme", "dark");
localStorage.setItem("csrfToken", credential);
sessionStorage.setItem("pushToken", credential);
localStorage.designTokens = credential;

// Allowed: a dynamic key is not statically known to be credential storage.
localStorage.setItem(dynamicKey, credential);

// Allowed: function parameters are runtime values even when their names look
// credential-like.
export const writeParameterKey = (tokenKey: string) => {
  localStorage[tokenKey] = credential;
};

// Allowed: mutable bindings can change between analysis and execution.
export const writeMutableKey = () => {
  localStorage[mutableTokenKey] = credential;
  mutableTokenKey = dynamicKey;
};

// Allowed: a call result is opaque without executing application code.
localStorage[getTokenKey()] = credential;

// Allowed: a computed method identifier is not the static setItem method.
localStorage[setItem]("accessToken", credential);

// Allowed: a same-named injected object is not the browser storage global.
export const writeInjectedStorage = (localStorage: {
  setItem: (key: string, value: string) => void;
}) => localStorage.setItem("accessToken", credential);

// Allowed: a locally shadowed window is not the browser global.
export const writeInjectedWindow = (window: {
  localStorage: { setItem: (key: string, value: string) => void };
}) => window.localStorage.setItem("jwt", credential);

// Allowed: an unrelated storage-shaped domain object.
declare const settingsStore: {
  setItem: (key: string, value: string) => void;
};
settingsStore.setItem("accessToken", credential);
