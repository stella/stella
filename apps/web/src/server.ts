import {
  createStartHandler,
  defaultRenderHandler,
} from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

const fetch = createStartHandler(defaultRenderHandler);

export default createServerEntry({
  fetch,
});
