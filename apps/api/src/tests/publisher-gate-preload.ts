import { afterEach, beforeEach } from "bun:test";

import { advancePublisherGateFixtureGeneration } from "@stll/case-law-adapters/publisher-gate-fixture-state";

// This preload belongs only to bun test commands, never environment setup for
// generators. It does not resolve runtime mode or import the adapter graph.
beforeEach(advancePublisherGateFixtureGeneration);
afterEach(advancePublisherGateFixtureGeneration);
