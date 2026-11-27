// Synthetic sources exercise each visible destination through its actual wrapper.
export const embeddedTextFixtures = [
  {
    name: "shape text",
    group: String.raw`{\shp{\*\shpinst{\sp{\sn property}{\sv hidden}}{\shptxt \b Box one\b0\par Box two}}}`,
  },
  {
    name: "starred shape text",
    group: String.raw`{\*\shp{\*\shpinst{\*\shptxt \b Box one\b0\par Box two}}}`,
  },
  {
    name: "drawing text box",
    group: String.raw`{\*\do\dptxbx{\dptxbxtext \b Box one\b0\par Box two}}`,
  },
  {
    name: "starred drawing text box",
    group: String.raw`{\*\do\dptxbx{\*\dptxbxtext \b Box one\b0\par Box two}}`,
  },
  {
    name: "object result",
    group: String.raw`{\object\objemb{\*\objclass hidden}{\*\objdata deadbeef}{\result \b Box one\b0\par Box two}}`,
  },
  {
    name: "starred object result",
    group: String.raw`{\object{\*\objdata deadbeef}{\*\result \b Box one\b0\par Box two}}`,
  },
  {
    name: "consecutive objects",
    group: String.raw`{\shp{\shptxt \b Box one\b0}}{\object{\result Box two}}`,
  },
];

export const embeddedTextRtf = (group: string) =>
  String.raw`{\rtf1\ansi\pard Anchor start ${group} anchor end\par Next paragraph\par}`;
