// Apply the system colour scheme before the module graph and stylesheet load.
// The React hook below keeps this state synchronized after startup.
(function () {
  const root = document.documentElement;
  const isDark = matchMedia("(prefers-color-scheme: dark)").matches;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  root.style.backgroundColor = isDark ? "#0c0c0d" : "#ffffff";
})();
