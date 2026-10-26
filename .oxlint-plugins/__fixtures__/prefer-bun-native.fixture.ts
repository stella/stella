// Passive regression fixture for `prefer-bun-native/no-buffer-string-encoding`
// and `prefer-bun-native/no-headers-from-entries`.

const bytes = new Uint8Array([1, 2, 3]);
const buffer = Buffer.from(bytes);
const request = new Request("https://example.test");

// MUST flag: Node's Buffer spelling of byte encoding.
// oxlint-disable-next-line prefer-bun-native/no-buffer-string-encoding -- fixture: hex through Buffer#toString must be rejected
export const hex = buffer.toString("hex");
// oxlint-disable-next-line prefer-bun-native/no-buffer-string-encoding -- fixture: base64 through Buffer#toString must be rejected
export const base64 = Buffer.from(bytes).toString("base64");
// oxlint-disable-next-line prefer-bun-native/no-buffer-string-encoding -- fixture: base64url through Buffer#toString must be rejected
export const base64Url = buffer.toString("base64url");

// Allowed: the native encoders, and a number's radix.
// expect-clean: prefer-bun-native/no-buffer-string-encoding
export const nativeHex = bytes.toHex();
// expect-clean: prefer-bun-native/no-buffer-string-encoding
export const radix = (255).toString(16);
// expect-clean: prefer-bun-native/no-buffer-string-encoding
export const utf8 = buffer.toString("utf-8");

// MUST flag: a Headers copied through a JavaScript iterator.
// oxlint-disable-next-line prefer-bun-native/no-headers-from-entries -- fixture: Headers entries must be read with toJSON
export const record = Object.fromEntries(request.headers.entries());
// oxlint-disable-next-line prefer-bun-native/no-headers-from-entries -- fixture: an iterated Headers must be read with toJSON
export const fromInit = Object.fromEntries(new Headers({ a: "1" }));

// Allowed: the native record, and any other iterable.
// expect-clean: prefer-bun-native/no-headers-from-entries
export const native = request.headers.toJSON();
// expect-clean: prefer-bun-native/no-headers-from-entries
export const fromMap = Object.fromEntries(new Map([["a", 1]]).entries());

// expect-clean: prefer-bun-native/no-buffer-string-encoding
export const custom = { toString: (format: "hex") => format }.toString("hex");
// expect-clean: prefer-bun-native/no-headers-from-entries
export const customHeaders = Object.fromEntries({ headers: new Map([["a", "1"]]) }.headers);
