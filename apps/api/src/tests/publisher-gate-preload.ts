import { afterEach, beforeEach } from "bun:test";

import { advancePublisherGateFixtureGeneration } from "../handlers/case-law/ingestion/adapters/publisher-gate-fixture-state";

// This preload belongs only to bun test commands, never environment setup for
// generators. It does not resolve runtime mode or import the adapter graph.
beforeEach(advancePublisherGateFixtureGeneration);
afterEach(advancePublisherGateFixtureGeneration);
