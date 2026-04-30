# Stella API

The Stella backend API built with [Elysia](https://elysiajs.com/) and [Rivet](https://www.rivet.dev/).

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
The Rivet dashboard serves on [http://localhost:6420](http://localhost:6420) by default.

## Good to know

You can find data stored by Rivet in `~/.local/share`. Whenever you update the rivet version you need to clear the stored data.
