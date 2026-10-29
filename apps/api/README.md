# Stella API

The Stella backend API, served by its own HTTP core on `Bun.serve`
(`src/http/`).

## Getting Started

### Install dependencies

```bash
bun install
```

### Run the development server

```bash
bun --filter @stll/api dev
```

The API serves on [http://localhost:3001](http://localhost:3001) by default.

Run `bun run check:registrations` from the repository root after adding an API route or error type to report missing registrations together.
