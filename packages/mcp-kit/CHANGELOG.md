# @stll/mcp-kit

## 0.2.4

### Patch Changes

- Updated dependencies [[`678a9d5`](https://github.com/stella/stella/commit/678a9d5c93cd72ff4d94d0bdb23c159982f710c9)]:
  - @stll/agent-input@0.2.0

## 0.2.3

### Patch Changes

- [#6343](https://github.com/stella/stella/pull/6343) [`fd168ab`](https://github.com/stella/stella/commit/fd168abcc2dcb8de45b0764687149049163c42fe) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep published clients independent from private workspace packages while preserving supported-version requests.

- [#6393](https://github.com/stella/stella/pull/6393) [`7ac81e4`](https://github.com/stella/stella/commit/7ac81e466061fa75b412e51f1a9faf7b7616c19c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Export `package.json` so consumers can read the installed package version.

- [#6343](https://github.com/stella/stella/pull/6343) [`fd168ab`](https://github.com/stella/stella/commit/fd168abcc2dcb8de45b0764687149049163c42fe) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Require supported local client versions, identify CLI and MCP kit requests, cache CLI update metadata, and turn incompatibilities into actionable update errors. Keep CLI version tests on the server metadata contract and scope the local-client CORS header to MCP transport requests.

- [#6233](https://github.com/stella/stella/pull/6233) [`7c455e3`](https://github.com/stella/stella/commit/7c455e3eed3319601db2a96bcb7e002f93c9d206) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Bound tool name suggestions to the tool name length.
- Updated dependencies [[`0e4c5d2`](https://github.com/stella/stella/commit/0e4c5d2457e5f027e1e986d8c5c96c7ae474c9f5), [`438816f`](https://github.com/stella/stella/commit/438816fdbd3c3e0b1ac8d8211a45feb2ad6109b0)]:
  - @stll/agent-input@0.1.7

## 0.2.2

### Patch Changes

- [#6184](https://github.com/stella/stella/pull/6184) [`b15dc7b`](https://github.com/stella/stella/commit/b15dc7bda66913f908106d46562a6270aa3bd322) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Name suggestions compute their distances without a native dependency.

## 0.2.1

### Patch Changes

- [#6090](https://github.com/stella/stella/pull/6090) [`d27ed17`](https://github.com/stella/stella/commit/d27ed17a2aa17be2b7f7c01d99217691db8ea1a3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Name suggestions count Unicode scalar values, so astral characters count as one edit.
- Updated dependencies []:
  - @stll/agent-input@0.1.6

## 0.2.0

### Minor Changes

- [#4573](https://github.com/stella/stella/pull/4573) [`413f66f`](https://github.com/stella/stella/commit/413f66f025fa97a87f5044c536c686431271960d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add opt-in discovery and invocation wire shapes, short tool briefs, described-schema discovery, and compact schema ceiling/dialect options for downstream CLIs. Preserve existing output by default.

  Retain the current agent-input normalization fixes: fractional values in integer fields are rejected, and prototype-named nested JSON properties are preserved.

  Add an opt-in property-based naming mode for hoisted schemas so downstream discovery retains stable definition and reference names.

## 0.1.0

### Minor Changes

- [#4343](https://github.com/stella/stella/pull/4343) [`d6c8112`](https://github.com/stella/stella/commit/d6c81123f0935108e79ba61e24f6d71fb0222824) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a framework-free MCP tool registry with compact schemas and lazy capability discovery.

### Patch Changes

- Updated dependencies [[`d6c8112`](https://github.com/stella/stella/commit/d6c81123f0935108e79ba61e24f6d71fb0222824)]:
  - @stll/agent-input@0.1.2
