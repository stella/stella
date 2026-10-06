// A suppression becoming unused proves the ownership detector stopped firing.

// oxlint-disable-next-line no-raw-browser-storage/no-raw-browser-storage -- Browser storage reads are confined to their owners.
export const direct = () => localStorage.getItem("key");

// oxlint-disable-next-line no-raw-browser-storage/no-raw-browser-storage -- Browser property access also crosses the owner boundary.
export const tab = () => window.sessionStorage;

// oxlint-disable-next-line no-raw-browser-storage/no-raw-browser-storage -- Global browser property access crosses the owner boundary.
export const global = () => globalThis.localStorage;

// oxlint-disable-next-line no-raw-browser-storage/no-raw-browser-storage -- Destructuring cannot bypass the storage owner.
export const { localStorage: local } = window;

// oxlint-disable-next-line no-raw-browser-storage/no-raw-browser-storage -- Computed literal access cannot bypass the storage owner.
export const computed = () => window["sessionStorage"];

// expect-clean: no-raw-browser-storage/no-raw-browser-storage
export const fixture = { localStorage: "fixture", sessionStorage: "fixture" };
