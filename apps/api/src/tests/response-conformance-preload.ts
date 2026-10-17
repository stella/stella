import { afterAll, afterEach, beforeEach } from "bun:test";

import { installResponseConformanceTestHooks } from "./helpers/response-conformance-sink";

// Runtime hooks belong only to bun test, never shared generator environment setup.
installResponseConformanceTestHooks({ beforeEach, afterEach, afterAll });
