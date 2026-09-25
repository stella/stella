# @stll/analytics-config

PostHog project configuration shared by the API and web analytics adapters.

## What lives here

When either app sends analytics (a real project, and a dev build only on
request), and the PostHog keys both sides must agree on, such as the
organization group type. The tests pin that behaviour.

## What does not

The adapters themselves: the server wraps `posthog-node` and the browser wraps
`posthog-js`, each with its own event list, redaction and wiring.

## License

Apache-2.0
