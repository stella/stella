// Apply the chosen colour scheme before the module graph and stylesheet load.
// The choice is the copy windows cache from the native preference
// (src/shared/desktop-appearance.ts); the React hook there reconciles it with
// the native side and keeps this state synchronized after startup.
(function () {
  const root = document.documentElement;
  let appearance = null;
  try {
    appearance = localStorage.getItem("stella-desktop-appearance");
  } catch {
    // Unreadable storage: follow the system until the native side answers.
  }
  const isDark =
    appearance === "dark" ||
    (appearance !== "light" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  root.style.backgroundColor = isDark ? "#0c0c0d" : "#ffffff";
})();
