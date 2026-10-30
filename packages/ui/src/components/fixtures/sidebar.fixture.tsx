import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { FileTextIcon, SearchIcon } from "../../icons";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "../sidebar";
import "./sidebar.fixture.css";

const directions = ["ltr", "rtl"] as const;
const sides = ["left", "right"] as const;
const variants = ["sidebar", "floating", "inset"] as const;

const searchParam = (key: string): string | null =>
  new URLSearchParams(window.location.search).get(key);

const isOneOf = <T extends readonly string[]>(
  value: string | null,
  options: T,
): value is T[number] => options.some((option) => option === value);

const directionValue = searchParam("dir");
const sideValue = searchParam("side");
const variantValue = searchParam("variant");
const insetValue = searchParam("inset");

if (
  !isOneOf(directionValue, directions) ||
  !isOneOf(sideValue, sides) ||
  !isOneOf(variantValue, variants) ||
  (insetValue !== "zero" && insetValue !== "safe")
) {
  panic("Invalid sidebar fixture parameters");
}

const direction = directionValue;
const side = sideValue;
const variant = variantValue;

document.documentElement.dir = direction;
document.documentElement.style.setProperty(
  "--safe-area-inline-start",
  insetValue === "safe" ? "44px" : "0px",
);
document.documentElement.style.setProperty(
  "--safe-area-inline-end",
  insetValue === "safe" ? "28px" : "0px",
);

const SidebarFixture = () => (
  <SidebarProvider
    className={side === "right" ? "flex-row-reverse" : undefined}
    defaultOpen={false}
  >
    <Sidebar
      className="isolate"
      collapsible="icon"
      data-surface="matter"
      side={side}
      style={{ opacity: 0.9 }}
      variant={variant}
    >
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton aria-label="Find motions">
                  <SearchIcon aria-hidden="true" />
                  <span>Find motions</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton aria-label="Filed orders">
                  <FileTextIcon aria-hidden="true" />
                  <span>Filed orders</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
    <SidebarInset data-testid="main-content">
      <SidebarTrigger label="Toggle fixture sidebar" />
      <button data-testid="main-action" type="button">
        Create matter
      </button>
    </SidebarInset>
  </SidebarProvider>
);

const root = document.querySelector("#root");
if (root === null) {
  panic("Missing sidebar fixture root");
}
createRoot(root).render(<SidebarFixture />);
