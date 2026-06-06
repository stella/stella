# @stll/legal-atlas-runner

Bun CLI and Docker runtime for `@stll/legal-atlas` corpus jobs.

```sh
bun --filter @stll/legal-atlas-runner smoke
bun --filter @stll/legal-atlas-runner start -- list
docker build -f apps/legal-atlas-runner/Dockerfile -t stella-legal-atlas .
```

Reusable adapters, parsers, fixtures, and corpus contracts belong in
`packages/legal-atlas`; this app should stay a thin runtime wrapper.
