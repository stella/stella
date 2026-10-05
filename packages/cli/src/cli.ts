#!/usr/bin/env bun
// Entry point for the `stella` CLI. It imports nothing but the dependency
// check, then loads the application shell (`cli-main.ts`) dynamically, so a
// checkout without its packages installed fails with one actionable line
// instead of a module-resolution stack trace. Every other load failure is
// rethrown untouched.

import { missingDependencyMessage } from "./missing-dependency.js";

try {
  await import("./cli-main.js");
} catch (error) {
  const message = missingDependencyMessage(error);
  if (message === null) {
    throw error;
  }
  process.stderr.write(`stella: ${message}\n`);
  // EXIT_CODES.unexpected; the constants module is not loaded on this path.
  process.exitCode = 1;
}
