# @stll/test-state

Serial test fixtures that restore environment and validated configuration.

## What lives here

`createTestState`, the one sanctioned way for a test to write `process.env`
or a validated configuration object: it records each first write and restores
it after the test, suite or file that made it. The `no-direct-test-state` lint
rule rejects direct writes in app and package tests alike.

## What does not

App-specific configuration: callers pass their own validated `env` object as
`config`.

## License

Apache-2.0
