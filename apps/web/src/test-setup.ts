// Tests must never inherit a developer deployment URL. A single preload owns
// this process-wide value so test files can restore it safely.
Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
});
