# @stll/html

## 0.1.0

### Minor Changes

- [#7418](https://github.com/stella/stella/pull/7418) [`68eeb7e`](https://github.com/stella/stella/commit/68eeb7e7dadeeca9efdd6458472a6a3b9187e173) Thanks [@jan-kubica](https://github.com/jan-kubica)! - First release: `load` parses HTML strings with parse5 and returns a Cheerio document without Cheerio's byte decoders or HTTP client; the root entry also carries the Cheerio types and `@stll/html/nodes` the DOM types and predicates, `@stll/html/bounded` limits allocations while loading, and `@stll/html/email` owns the scripting-disabled mode for email previews.
