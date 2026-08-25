import { setDefaultTimeout } from "bun:test";

import { propertyTestDefaultTimeout } from "./index";

// Property runs multiply fast-check's work, so Bun's default test budget must
// grow with the same factor. This module is intentionally a preload: unlike a
// shared import, its side effect is explicit at each `test:property` boundary.
setDefaultTimeout(propertyTestDefaultTimeout());
