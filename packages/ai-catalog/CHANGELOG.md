# @stll/ai-catalog

## 0.1.2

### Patch Changes

- [#2450](https://github.com/stella/stella/pull/2450) [`fe5e771`](https://github.com/stella/stella/commit/fe5e7716a5d322aa23fbc3c8f683ae27a6142f51) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Refresh gpt-5.6 rate schedule to match upstream cost metadata.

## 0.1.1

### Patch Changes

- [#2351](https://github.com/stella/stella/pull/2351) [`cd9f59f`](https://github.com/stella/stella/commit/cd9f59fab6d4630aed50f982826d41a4671eb8ed) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update Gemini 3.6 Flash promotional rates and keep floating Google aliases outside fixed-model metadata.

## 0.1.0

### Minor Changes

- [#2343](https://github.com/stella/stella/pull/2343) [`7434f4c`](https://github.com/stella/stella/commit/7434f4ca59ed432548d1e96d28c8965b6bd2a130) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish the provider-neutral model catalogue and placeholder-safe reversible
  anonymization pipeline as supported packages. Add exact sensitive-value inputs
  to the anonymization pipeline so callers can protect identifiers in the same
  redaction allocation as detected entities, and expose placeholder scanning so
  hosts can reject unknown response tokens before restoration.
