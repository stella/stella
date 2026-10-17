// Bun test preload: `preload = ["@stll/test-kit/forbid-network"]` in bunfig.
// A suite that reaches a service container by name calls
// `installNetworkGuard({ allowHosts: [...] })` from its own preload instead.
import { installNetworkGuard } from "./network.ts";

installNetworkGuard();
