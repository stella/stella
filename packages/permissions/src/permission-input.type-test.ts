import { expectTypeOf } from "bun:test";

import type { PermissionInput, statements } from "./index";

type PermissionMap = {
  [K in keyof typeof statements]: (typeof statements)[K][number][];
};

type LegacyRequireAtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

type LegacyPermissionInput = LegacyRequireAtLeastOne<Partial<PermissionMap>>;

// The current input accepts exactly what the legacy one accepted, both ways.
expectTypeOf<LegacyPermissionInput>().toExtend<PermissionInput>();
expectTypeOf<PermissionInput>().toExtend<LegacyPermissionInput>();

// An empty input and an unknown action stay rejected.
expectTypeOf<Record<never, never>>().not.toExtend<PermissionInput>();
expectTypeOf<{ workspace: ["invalid"] }>().not.toExtend<PermissionInput>();

// An input naming several resources stays accepted.
expectTypeOf<{
  member: ["create"];
  workspace: ["read"];
}>().toExtend<PermissionInput>();
