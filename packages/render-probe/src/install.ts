// Import first, before anything loads React: a renderer reads the DevTools
// hook once, when its module initialises, so a probe installed later sees
// nothing. Development builds and tests only.
import { installRenderProbe } from "./probe";

installRenderProbe();
