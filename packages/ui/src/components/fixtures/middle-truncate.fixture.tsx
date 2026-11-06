import { createRoot } from "react-dom/client";

import { MiddleTruncate } from "../middle-truncate";
import "./middle-truncate.fixture.css";

const params = new URLSearchParams(location.search);
const rtl = params.get("rtl") === "true";
document.documentElement.dir = rtl ? "rtl" : "ltr";
document.documentElement.lang = rtl ? "ar" : "en";

const value = rtl
  ? "عقد الخدمات النهائي - مراجعة العميل.docx"
  : "Smlouva o dílo – revize klienta.docx";

const Fixture = () => (
  <main>
    <div data-testid="frame">
      <MiddleTruncate value={value} />
    </div>
  </main>
);

const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(<Fixture />);
}
