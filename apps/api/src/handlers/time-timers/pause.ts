import { createTimerStateHandler } from "./state-transition";

const pauseTimer = createTimerStateHandler({
  state: "paused",
  description:
    "Pause your timer without creating a time entry. Pausing an already paused timer leaves its elapsed time unchanged.",
});
export default pauseTimer;
