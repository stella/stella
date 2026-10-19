# @stll/mcp-kit

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
