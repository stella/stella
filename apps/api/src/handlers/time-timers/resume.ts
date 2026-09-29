import { createTimerStateHandler } from "./state-transition";

const resumeTimer = createTimerStateHandler({
  state: "running",
  description:
    "Resume your paused timer and automatically pause your other running timer. Resuming an already running timer leaves its elapsed time unchanged.",
});
export default resumeTimer;
