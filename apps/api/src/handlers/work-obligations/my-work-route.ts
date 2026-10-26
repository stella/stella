import myWork from "@/api/handlers/work-obligations/queues/list";
import { routes } from "@/api/http/route";

export const myWorkRoute = routes(
  {
    "/": { GET: myWork },
  },
  { prefix: "/my-work" },
);
