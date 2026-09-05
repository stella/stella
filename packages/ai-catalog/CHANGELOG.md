# @stll/ai-catalog

## 0.1.8

### Patch Changes

- [#2964](https://github.com/stella/stella/pull/2964) [`1fb4010`](https://github.com/stella/stella/commit/1fb4010246452305e40451d0be55fb47e1bbd955) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Offer GPT-6 Astra directly from OpenAI and through OpenRouter, with sourced rates, reasoning efforts, and document input.

## 0.1.7

### Patch Changes

- [#2896](https://github.com/stella/stella/pull/2896) [`78ba470`](https://github.com/stella/stella/commit/78ba470fe151fa51d11a1a17ec917c7b190fae50) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Generate model rates from models.dev and meter its current cache-read, cache-write, and context-tier pricing.

## 0.1.6

### Patch Changes

- [#2867](https://github.com/stella/stella/pull/2867) [`5de796a`](https://github.com/stella/stella/commit/5de796a05e94a1575fec5cb9e609652d38ca4fb6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Offer Gemini 3.8 Flash with its upstream rates, 1M context window, and generated capabilities.

## 0.1.5

### Patch Changes

- [#2775](https://github.com/stella/stella/pull/2775) [`adf4b33`](https://github.com/stella/stella/commit/adf4b33d155ab13aecb35cdf8c8a444850214afb) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Offer Claude Fable 5.1 with its upstream rates, 1M context window, and generated capabilities.

## 0.1.4

### Patch Changes

- [#2584](https://github.com/stella/stella/pull/2584) [`c918286`](https://github.com/stella/stella/commit/c9182860575e40ae1ad3b6f81bfc7e85362f8b62) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Default the Mistral chat role to `mistral-medium-latest`; `mistral-large-latest` is gated behind a higher subscription tier.

- [#2568](https://github.com/stella/stella/pull/2568) [`760149f`](https://github.com/stella/stella/commit/760149f073adf3b8e45a9ece4df179d7ef8c7bd2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the GPT-5.6 model family

## 0.1.3

### Patch Changes

- [#2555](https://github.com/stella/stella/pull/2555) [`c25277d`](https://github.com/stella/stella/commit/c25277d7730f0e8e2723ee9637edf0981e85c192) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Refresh generated temperature policies from upstream model metadata.

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
