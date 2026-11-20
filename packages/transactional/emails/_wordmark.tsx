import { Img } from "../components/img";
import { Section } from "../components/section";
import { ICON_URL, sharedStyles } from "./_shared";

/** The stella icon the branded emails open with. */
export const Wordmark = () => (
  <Section style={sharedStyles.wordmarkSection}>
    <Img
      alt="stella"
      height="40"
      src={ICON_URL}
      style={{ margin: "0 auto", display: "block" }}
      width="40"
    />
  </Section>
);
