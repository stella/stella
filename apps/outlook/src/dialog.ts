const destination = new URL("/sign-in-outlook", globalThis.STELLA_WEB_ORIGIN);
const parentOrigin = new URL(window.location.href).searchParams.get(
  "parentOrigin",
);
if (parentOrigin) {
  destination.searchParams.set("parentOrigin", parentOrigin);
}
window.location.replace(destination);
