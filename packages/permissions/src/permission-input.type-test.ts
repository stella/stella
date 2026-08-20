import type { PermissionInput, statements } from "./index";

type PermissionMap = {
  [K in keyof typeof statements]: (typeof statements)[K][number][];
};

type LegacyRequireAtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

type LegacyPermissionInput = LegacyRequireAtLeastOne<Partial<PermissionMap>>;

type Assert<T extends true> = T;
type Extends<T, U> = [T] extends [U] ? true : false;

export type PermissionInputAcceptsEverythingLegacyAccepted = Assert<
  Extends<LegacyPermissionInput, PermissionInput>
>;

export type LegacyPermissionInputAcceptsEverythingCurrentAccepts = Assert<
  Extends<PermissionInput, LegacyPermissionInput>
>;

export type EmptyPermissionInputRemainsRejected = Assert<
  Extends<Record<never, never>, PermissionInput> extends false ? true : false
>;

export type InvalidPermissionActionRemainsRejected = Assert<
  Extends<{ workspace: ["invalid"] }, PermissionInput> extends false
    ? true
    : false
>;

export type MultiResourcePermissionInputRemainsAccepted = Assert<
  Extends<{ member: ["create"]; workspace: ["read"] }, PermissionInput>
>;
