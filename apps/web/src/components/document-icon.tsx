import type { SVGProps } from "react";
import { useId } from "react";

import { File, FileImage, FileText, MailIcon } from "lucide-react";

import { getDocumentIconKind } from "@/components/document-icon.logic";
import { MarkdownIcon } from "@/components/markdown-icon";

// Page body shared by all three: white sheet, folded top-right corner, grey
// outline, in a 48×48 viewBox.
const OfficePage = () => (
  <>
    <path
      d="M13.5 44h29c.275 0 .5-.225.5-.5V14h-8.5c-.827 0-1.5-.673-1.5-1.5V4H13.5c-.275 0-.5.225-.5.5v39c0 .275.225.5.5.5z"
      fill="#fff"
    />
    <path d="M42.293 13 34 4.707V12.5c0 .275.225.5.5.5h7.793z" fill="#fff" />
    <path
      clipRule="evenodd"
      d="m43.56 12.854-9.414-9.415A1.51 1.51 0 0 0 33.086 3H13.5c-.827 0-1.5.673-1.5 1.5v39c0 .827.673 1.5 1.5 1.5h29c.827 0 1.5-.673 1.5-1.5V13.914c0-.4-.156-.777-.44-1.06zM34 4.707 42.293 13H34.5a.501.501 0 0 1-.5-.5V4.707zM13.5 44h29c.275 0 .5-.225.5-.5V14h-8.5c-.827 0-1.5-.673-1.5-1.5V4H13.5c-.275 0-.5.225-.5.5v39a.5.5 0 0 0 .5.5z"
      fill="#605E5C"
      fillRule="evenodd"
      opacity=".64"
    />
  </>
);

export const DocxIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="none"
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <OfficePage />
    <path d="M39.5 30H28v1h11.5a.5.5 0 0 0 0-1z" fill="#103F91" />
    <path d="M39.5 27H28v1h11.5a.5.5 0 0 0 0-1z" fill="#185ABD" />
    <path d="M39.5 24H28v1h11.5a.5.5 0 0 0 0-1z" fill="#2B7CD3" />
    <path d="M39.5 21H28v1h11.5a.5.5 0 0 0 0-1z" fill="#41A5EE" />
    <path
      d="M6 37h18a2 2 0 0 0 2-2V17a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2z"
      fill="#185ABD"
    />
    <path
      d="M11.829 29.322c.033.262.055.49.065.684h.038c.045-.446.117-.89.214-1.328L13.921 21h2.295l1.836 7.564c.092.373.168.848.23 1.426h.03c.026-.399.09-.859.191-1.38l1.47-7.61h2.088l-2.57 11H17.05l-1.752-7.287c-.051-.21-.109-.484-.172-.822a10.585 10.585 0 0 1-.119-.736h-.03c-.02.18-.06.446-.119.798-.059.354-.106.613-.141.783L13.072 32h-2.479L8 21h2.127l1.598 7.694c.036.159.07.369.104.628z"
      fill="#F9F7F7"
    />
  </svg>
);

// Green lettered badge, shared by the XLSX and CSV marks.
const SpreadsheetBadge = () => (
  <>
    <path
      d="M6 37h18a2 2 0 002-2V17a2 2 0 00-2-2H6a2 2 0 00-2 2v18a2 2 0 002 2z"
      fill="#107C41"
    />
    <path
      d="M9.518 32l3.851-6.017L9.841 20h2.839l1.926 3.825c.177.362.298.633.365.811h.025c.127-.29.26-.572.398-.845L17.454 20h2.605l-3.62 5.95L20.15 32h-2.772l-2.225-4.2a3.522 3.522 0 01-.265-.561h-.033a2.605 2.605 0 01-.257.543L12.307 32h-2.79z"
      fill="#F9F7F7"
    />
  </>
);

export const XlsxIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="none"
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <OfficePage />
    <path d="M39 31h-3a1 1 0 110-2h3a1 1 0 110 2z" fill="#134A2C" />
    <path d="M32 31h-3a1 1 0 110-2h3a1 1 0 110 2z" fill="#185C37" />
    <path d="M39 27h-3a1 1 0 110-2h3a1 1 0 110 2z" fill="#21A366" />
    <path d="M32 27h-3a1 1 0 110-2h3a1 1 0 110 2z" fill="#107C41" />
    <path d="M39 23h-3a1 1 0 110-2h3a1 1 0 110 2z" fill="#33C481" />
    <path d="M32 23h-3a1 1 0 110-2h3a1 1 0 110 2z" fill="#21A366" />
    <SpreadsheetBadge />
  </svg>
);

export const PptxIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="none"
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <OfficePage />
    <path d="M39.5 21H28v2h11.5a.5.5 0 0 0 0-1z" fill="#D24726" />
    <path d="M33 25h-5v6h5z" fill="#FF8F6B" />
    <path d="M39.5 25H35v1h4.5a.5.5 0 0 0 0-1z" fill="#D24726" />
    <path d="M39.5 28H35v1h4.5a.5.5 0 0 0 0-1z" fill="#E86F45" />
    <path d="M39.5 31H35v1h4.5a.5.5 0 0 0 0-1z" fill="#FF8F6B" />
    <path
      d="M6 37h18a2 2 0 0 0 2-2V17a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2z"
      fill="#D24726"
    />
    <path
      d="M10 20h5.59c3.47 0 5.41 1.78 5.41 4.82 0 3.2-2.08 5.08-5.63 5.08h-1.94V33H10V20zm3.43 2.78v4.35h1.62c1.63 0 2.47-.73 2.47-2.2 0-1.44-.84-2.15-2.47-2.15h-1.62z"
      fill="#F9F7F7"
    />
  </svg>
);

// The CSV mark pairs the spreadsheet badge with an "a," glyph: same workbook
// family, marked as delimited text.
export const CsvIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="none"
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <OfficePage />
    <path
      d="M36 31.03h-1.58v-1.54h-.038c-.687 1.187-1.699 1.781-3.034 1.781-.95 0-1.711-.258-2.282-.775-.572-.517-.858-1.212-.858-2.085 0-1.837 1.085-2.909 3.255-3.217l2.957-.414c0-1.67-.678-2.504-2.032-2.504-1.188 0-2.26.401-3.217 1.203v-1.618c.289-.218.784-.428 1.483-.63.7-.202 1.323-.304 1.869-.304 2.317 0 3.477 1.23 3.477 3.69v6.413zm-1.58-4.989l-2.388.337c-.816.116-1.387.31-1.715.583-.327.273-.49.715-.49 1.324 0 .495.175.891.528 1.19.354.299.806.448 1.359.448.783 0 1.43-.276 1.94-.829.51-.552.767-1.242.767-2.07v-.983zm5.58 3.23L38.468 34h-1.126l1.126-4.729H40z"
      fill="#33C481"
    />
    <SpreadsheetBadge />
  </svg>
);

export const RtfIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-hidden="true"
    fill="none"
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      fill="#FFF"
      d="M9.5 44h29c.275 0 .5-.225.5-.5V14h-8.5c-.827 0-1.5-.673-1.5-1.5V4H9.5c-.275 0-.5.225-.5.5v39c0 .275.225.5.5.5z"
    />
    <path fill="#FFF" d="M38.293 13L30 4.707V12.5c0 .275.225.5.5.5h7.793z" />
    <path
      opacity=".64"
      fill="#605E5C"
      d="M39.56 12.854l-9.414-9.415A1.51 1.51 0 0029.086 3H9.5C8.673 3 8 3.673 8 4.5v39c0 .827.673 1.5 1.5 1.5h29c.827 0 1.5-.673 1.5-1.5V13.914c0-.4-.156-.777-.44-1.06zM30 4.707L38.293 13H30.5a.501.501 0 01-.5-.5V4.707zM38.5 44h-29a.501.501 0 01-.5-.5v-39c0-.275.225-.5.5-.5H29v8.5c0 .827.673 1.5 1.5 1.5H39v29.5c0 .275-.225.5-.5.5z"
    />
    <path
      fill="#69AFE5"
      d="M35.5 21h-14a.5.5 0 010-1h14a.5.5 0 010 1zm0 3h-14a.5.5 0 010-1h14a.5.5 0 010 1z"
    />
    <path fill="#0078D7" d="M35.5 27h-23a.5.5 0 010-1h23a.5.5 0 010 1z" />
    <path
      fill="#C8C6C4"
      d="M22.5 30h-10a.5.5 0 010-1h10a.5.5 0 010 1zm0 3h-10a.5.5 0 010-1h10a.5.5 0 010 1zm0 3h-10a.5.5 0 010-1h10a.5.5 0 010 1z"
    />
    <path
      fill="#69AFE5"
      d="M35 36h-9a1 1 0 01-1-1v-5a1 1 0 011-1h9a1 1 0 011 1v5a1 1 0 01-1 1z"
    />
    <path
      fill="#0078D7"
      d="M20 24h-1.751l-.696-1.817h-3.187L13.708 24H12l3.105-8h1.703L20 24zm-2.964-3.165l-1.099-2.969-1.076 2.969h2.175z"
    />
  </svg>
);

// ODT and ODS ship generic gradient ids, so every instance namespaces them
// with useId: two of these marks on one page would otherwise resolve each
// other's gradients.
export const OdtIcon = (props: SVGProps<SVGSVGElement>) => {
  const uid = useId();

  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <polygon fill="#FFFFFF" points="43,44 13,44 13,4 34,4 43,13" />
        <path
          fill="#949494"
          d="M34.0005,3H12v42h32V13L34.0005,3z M34,4.5l8.5,8.5H34V4.5z M43,44H13V4h20v10h10V44z"
        />
      </g>
      <rect x="24" y="35" fill="#C8C8C8" width="16" height="1" />
      <rect x="24" y="32" fill="#C8C8C8" width="16" height="1" />
      <rect x="24" y="38" fill="#C8C8C8" width="16" height="1" />
      <polygon fill="#2B579A" points="4,17 24,14 24,40 4,37" />
      <g>
        <path
          fill="#FFFFFF"
          d="M21,22l-2.6241,10h-2.4787l-1.6479-6.4156c-0.0878-0.3347-0.1409-0.7088-0.1592-1.1227h-0.0277
      c-0.0415,0.4558-0.1016,0.8298-0.18,1.1227L12.1929,32H9.6103L7,22h2.4441l1.3986,6.6597
      c0.0598,0.2837,0.1039,0.665,0.1316,1.1437h0.0415c0.0183-0.3579,0.0853-0.7484,0.2008-1.1715L13.0168,22h2.3956l1.6271,6.7155
      c0.0598,0.2466,0.113,0.6045,0.1592,1.0739h0.0277c0.0183-0.3671,0.0668-0.7392,0.1454-1.1158L18.7428,22H21z"
        />
      </g>
      <g>
        <path
          fill="#ACBBE3"
          d="M33.0381,18c1.0137,0,1.6631,0.5059,2.0293,0.9307c0.6475,0.7505,0.9502,1.8481,0.9063,3.0693h2.0161
      c0.0923-3.3911-1.9761-6-4.9517-6s-5.8179,2.6089-6.7314,6h2.0923C29.2051,19.7324,31.1221,18,33.0381,18z"
        />
        <path
          fill="#ACBBE3"
          d="M30.9619,28c-1.0137,0-1.6631-0.5059-2.0293-0.9307c-0.6475-0.7505-0.9502-1.8481-0.9063-3.0693h-2.0161
      c-0.0923,3.3911,1.9761,6,4.9517,6s5.8179-2.6089,6.7314-6h-2.0923C34.7949,26.2676,32.8779,28,30.9619,28z"
        />
      </g>
      <linearGradient
        id={`${uid}-1`}
        gradientUnits="userSpaceOnUse"
        x1="8.5867"
        y1="5.8641"
        x2="42.4893"
        y2="46.2676"
      >
        <stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
        <stop offset="0.2264" stopColor="#FCFCFC" stopOpacity={0.0226} />
        <stop offset="0.3626" stopColor="#F4F4F4" stopOpacity={0.0363} />
        <stop offset="0.475" stopColor="#E6E6E6" stopOpacity={0.0475} />
        <stop offset="0.5744" stopColor="#D1D1D1" stopOpacity={0.0574} />
        <stop offset="0.6652" stopColor="#B7B7B7" stopOpacity={0.0665} />
        <stop offset="0.7498" stopColor="#979797" stopOpacity={0.075} />
        <stop offset="0.8297" stopColor="#707070" stopOpacity={0.083} />
        <stop offset="0.9057" stopColor="#444444" stopOpacity={0.0906} />
        <stop offset="0.9761" stopColor="#121212" stopOpacity={0.0976} />
        <stop offset="1" stopColor="#000000" stopOpacity={0.1} />
      </linearGradient>
      <path fill={`url(#${uid}-1)`} d="M44,13L34,3H12v42h32V13z" />
      <linearGradient
        id={`${uid}-2`}
        gradientUnits="userSpaceOnUse"
        x1="38"
        y1="16.9063"
        x2="38"
        y2="14.0875"
      >
        <stop offset="0" stopColor="#828282" stopOpacity={0} />
        <stop offset="0.2812" stopColor="#7F7F7F" stopOpacity={0.0281} />
        <stop offset="0.4503" stopColor="#777777" stopOpacity={0.045} />
        <stop offset="0.5899" stopColor="#696969" stopOpacity={0.059} />
        <stop offset="0.7133" stopColor="#545454" stopOpacity={0.0713} />
        <stop offset="0.8259" stopColor="#3A3A3A" stopOpacity={0.0826} />
        <stop offset="0.9294" stopColor="#1A1A1A" stopOpacity={0.0929} />
        <stop offset="1" stopColor="#000000" stopOpacity={0.1} />
      </linearGradient>
      <rect x="33" y="14" fill={`url(#${uid}-2)`} width="10" height="3" />
      <linearGradient
        id={`${uid}-3`}
        gradientUnits="userSpaceOnUse"
        x1="31.27"
        y1="12.23"
        x2="37.2361"
        y2="6.2639"
      >
        <stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
        <stop offset="0.8537" stopColor="#FFFFFF" stopOpacity={0.2134} />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity={0.25} />
      </linearGradient>
      <polygon
        fill={`url(#${uid}-3)`}
        points="12,3 12,4 33,4 33,14 43,14 43,28 44,28 44,13 34,3"
      />
      <linearGradient
        id={`${uid}-4`}
        gradientUnits="userSpaceOnUse"
        x1="14"
        y1="39.1875"
        x2="14"
        y2="14.7584"
      >
        <stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
        <stop offset="0.8587" stopColor="#FFFFFF" stopOpacity={0.1546} />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity={0.18} />
      </linearGradient>
      <polygon fill={`url(#${uid}-4)`} points="24,14 4,17 4,37 24,40" />
      <linearGradient
        id={`${uid}-5`}
        gradientUnits="userSpaceOnUse"
        x1="17.7538"
        y1="42.9183"
        x2="18.1773"
        y2="38.93"
      >
        <stop offset="0" stopColor="#828282" stopOpacity={0} />
        <stop offset="0.1699" stopColor="#7E7E7E" stopOpacity={0.0341} />
        <stop offset="0.346" stopColor="#717171" stopOpacity={0.0694} />
        <stop offset="0.5248" stopColor="#5D5D5D" stopOpacity={0.1053} />
        <stop offset="0.7057" stopColor="#404040" stopOpacity={0.1415} />
        <stop offset="0.8863" stopColor="#1B1B1B" stopOpacity={0.1778} />
        <stop offset="0.9972" stopColor="#000000" stopOpacity={0.2} />
      </linearGradient>
      <polygon fill={`url(#${uid}-5)`} points="24,43 12,43 12,38.2 24,40" />
      <linearGradient
        id={`${uid}-6`}
        gradientUnits="userSpaceOnUse"
        x1="14"
        y1="39.1875"
        x2="14"
        y2="14.7584"
      >
        <stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
        <stop offset="0.8587" stopColor="#FFFFFF" stopOpacity={0.1546} />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity={0.18} />
      </linearGradient>
      <polygon fill={`url(#${uid}-6)`} points="24,14 4,17 4,37 24,40" />
    </svg>
  );
};

export const OdsIcon = (props: SVGProps<SVGSVGElement>) => {
  const uid = useId();

  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g>
        <polygon fill="#FFFFFF" points="43,44 13,44 13,4 34,4 43,13" />
        <path
          fill="#949494"
          d="M34.0005,3H12v42h32V13L34.0005,3z M34,4.5l8.5,8.5H34V4.5z M43,44H13V4h20v10h10V44z"
        />
      </g>
      <rect x="24" y="35" fill="#C8C8C8" width="16" height="1" />
      <rect x="24" y="32" fill="#C8C8C8" width="16" height="1" />
      <rect x="24" y="38" fill="#C8C8C8" width="16" height="1" />
      <polygon fill="#217346" points="4,17 24,14 24,40 4,37" />
      <g>
        <path
          fill="#FFFFFF"
          d="M19,33h-2.8819l-1.8585-3.9079c-0.0703-0.1449-0.143-0.4127-0.2182-0.8033h-0.0301
      c-0.0353,0.1841-0.118,0.4631-0.2483,0.8368L11.8969,33H9l3.4387-6l-3.1452-6h2.9571l1.5425,3.5983
      c0.1204,0.2845,0.2281,0.6221,0.3236,1.0126h0.0301c0.0602-0.2343,0.1731-0.5829,0.3386-1.046L16.2009,21h2.7088l-3.2355,5.9498
      L19,33z"
        />
      </g>
      <g>
        <path
          fill="#8BBF8A"
          d="M33.0381,18c1.0137,0,1.6631,0.5059,2.0293,0.9307c0.6475,0.7505,0.9502,1.8481,0.9063,3.0693h2.0161
      c0.0923-3.3911-1.9761-6-4.9517-6s-5.8179,2.6089-6.7314,6h2.0923C29.2051,19.7324,31.1221,18,33.0381,18z"
        />
        <path
          fill="#8BBF8A"
          d="M30.9619,28c-1.0137,0-1.6631-0.5059-2.0293-0.9307c-0.6475-0.7505-0.9502-1.8481-0.9063-3.0693h-2.0161
      c-0.0923,3.3911,1.9761,6,4.9517,6s5.8179-2.6089,6.7314-6h-2.0923C34.7949,26.2676,32.8779,28,30.9619,28z"
        />
      </g>
      <linearGradient
        id={`${uid}-1`}
        gradientUnits="userSpaceOnUse"
        x1="8.5867"
        y1="5.8641"
        x2="42.4893"
        y2="46.2676"
      >
        <stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
        <stop offset="0.2264" stopColor="#FCFCFC" stopOpacity={0.0226} />
        <stop offset="0.3626" stopColor="#F4F4F4" stopOpacity={0.0363} />
        <stop offset="0.475" stopColor="#E6E6E6" stopOpacity={0.0475} />
        <stop offset="0.5744" stopColor="#D1D1D1" stopOpacity={0.0574} />
        <stop offset="0.6652" stopColor="#B7B7B7" stopOpacity={0.0665} />
        <stop offset="0.7498" stopColor="#979797" stopOpacity={0.075} />
        <stop offset="0.8297" stopColor="#707070" stopOpacity={0.083} />
        <stop offset="0.9057" stopColor="#444444" stopOpacity={0.0906} />
        <stop offset="0.9761" stopColor="#121212" stopOpacity={0.0976} />
        <stop offset="1" stopColor="#000000" stopOpacity={0.1} />
      </linearGradient>
      <path fill={`url(#${uid}-1)`} d="M44,13L34,3H12v42h32V13z" />
      <linearGradient
        id={`${uid}-2`}
        gradientUnits="userSpaceOnUse"
        x1="38"
        y1="16.9063"
        x2="38"
        y2="14.0875"
      >
        <stop offset="0" stopColor="#828282" stopOpacity={0} />
        <stop offset="0.2812" stopColor="#7F7F7F" stopOpacity={0.0281} />
        <stop offset="0.4503" stopColor="#777777" stopOpacity={0.045} />
        <stop offset="0.5899" stopColor="#696969" stopOpacity={0.059} />
        <stop offset="0.7133" stopColor="#545454" stopOpacity={0.0713} />
        <stop offset="0.8259" stopColor="#3A3A3A" stopOpacity={0.0826} />
        <stop offset="0.9294" stopColor="#1A1A1A" stopOpacity={0.0929} />
        <stop offset="1" stopColor="#000000" stopOpacity={0.1} />
      </linearGradient>
      <rect x="33" y="14" fill={`url(#${uid}-2)`} width="10" height="3" />
      <linearGradient
        id={`${uid}-3`}
        gradientUnits="userSpaceOnUse"
        x1="31.27"
        y1="12.23"
        x2="37.2361"
        y2="6.2639"
      >
        <stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
        <stop offset="0.8537" stopColor="#FFFFFF" stopOpacity={0.2134} />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity={0.25} />
      </linearGradient>
      <polygon
        fill={`url(#${uid}-3)`}
        points="12,3 12,4 33,4 33,14 43,14 43,28 44,28 44,13 34,3"
      />
      <linearGradient
        id={`${uid}-4`}
        gradientUnits="userSpaceOnUse"
        x1="17.7538"
        y1="42.9183"
        x2="18.1773"
        y2="38.93"
      >
        <stop offset="0" stopColor="#828282" stopOpacity={0} />
        <stop offset="0.1699" stopColor="#7E7E7E" stopOpacity={0.0341} />
        <stop offset="0.346" stopColor="#717171" stopOpacity={0.0694} />
        <stop offset="0.5248" stopColor="#5D5D5D" stopOpacity={0.1053} />
        <stop offset="0.7057" stopColor="#404040" stopOpacity={0.1415} />
        <stop offset="0.8863" stopColor="#1B1B1B" stopOpacity={0.1778} />
        <stop offset="0.9972" stopColor="#000000" stopOpacity={0.2} />
      </linearGradient>
      <polygon fill={`url(#${uid}-4)`} points="24,43 12,43 12,38.2 24,40" />
      <linearGradient
        id={`${uid}-5`}
        gradientUnits="userSpaceOnUse"
        x1="14"
        y1="39.1875"
        x2="14"
        y2="14.7584"
      >
        <stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
        <stop offset="0.8587" stopColor="#FFFFFF" stopOpacity={0.1546} />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity={0.18} />
      </linearGradient>
      <polygon fill={`url(#${uid}-5)`} points="24,14 4,17 4,37 24,40" />
    </svg>
  );
};

type PdfIconProps = {
  className?: string | undefined;
};

const PdfIcon = ({ className }: PdfIconProps) => (
  <svg
    aria-hidden="true"
    className={className}
    height="92.604164mm"
    viewBox="0 0 75.320129 92.604164"
    width="75.320129mm"
    xmlns="http://www.w3.org/2000/svg"
  >
    <g transform="translate(53.55 -183.98) scale(1.48)">
      <path
        color="#000"
        d="M-29.63 123.95c-3.55 0-6.44 2.89-6.44 6.45v49.5c0 3.55 2.89 6.45 6.44 6.45H8.22c3.55 0 6.44-2.89 6.44-6.45v-40.7s.1-1.19-.42-2.35c-.48-1.09-1.28-1.84-1.28-1.84a1.06 1.06 0 0 0-.01-.01l-9.39-9.21a1.06 1.06 0 0 0-.02-.02s-.8-.76-1.99-1.27c-1.4-.6-2.84-.54-2.84-.54l.02-.0z"
        fill="#ff2116"
        fontFamily="sans-serif"
        overflow="visible"
        paintOrder="markers fill stroke"
      />
      <path
        color="#000"
        d="M-29.63 126.06h28.38a1.06 1.06 0 0 0 .02 0s1.13.01 1.96.37c.8.34 1.37.86 1.37.87.0.0.0.0.0.0l9.37 9.19s.56.6.84 1.21c.22.49.23 1.4.23 1.4a1.06 1.06 0 0 0-.0.04v40.75c0 2.42-1.91 4.33-4.33 4.33H-29.63c-2.42 0-4.33-1.91-4.33-4.33v-49.5c0-2.42 1.91-4.33 4.33-4.33z"
        fill="#f5f5f5"
        fontFamily="sans-serif"
        overflow="visible"
        paintOrder="markers fill stroke"
      />
      <path
        d="M-23.41 161.09c-1.46-1.46.12-3.46 4.4-5.58l2.69-1.34 1.05-2.29c.58-1.26 1.44-3.32 1.91-4.57l.86-2.28-.6-1.69c-.73-2.08-.99-5.19-.53-6.32.63-1.52 2.69-1.36 3.51.27.64 1.27.57 3.57-.18 6.48l-.62 2.38.55.93c.3.51 1.18 1.72 1.95 2.69l1.45 1.8 1.8-.24c5.73-.75 7.69.52 7.69 2.34 0 2.3-4.5 2.49-8.28-.16-.85-.6-1.43-1.19-1.43-1.19s-2.37.48-3.53.8c-1.2.32-1.8.53-3.56 1.12 0 0-.62.9-1.02 1.55-1.5 2.43-3.25 4.44-4.5 5.17-1.4.82-2.87.88-3.6.14zm2.29-.82c.82-.51 2.48-2.47 3.62-4.29l.46-.74-2.11 1.06c-3.27 1.64-4.76 3.19-3.98 4.13.44.53.96.48 2.01-.17zm21.22-5.96c.8-.56.68-1.69-.22-2.15-.7-.35-1.27-.43-3.1-.4-1.12.08-2.93.3-3.24.37 0 0 .99.69 1.43.94.59.34 2.01.96 3.06 1.28 1.03.31 1.62.28 2.07-.04zm-8.53-3.55c-.48-.51-1.31-1.57-1.83-2.36-.68-.9-1.03-1.53-1.03-1.53s-.5 1.61-.91 2.57l-1.28 3.16-.37.72s1.97-.65 2.97-.91c1.06-.28 3.22-.7 3.22-.7zm-2.75-11.03c.12-1.04.18-2.07-.16-2.6-.92-1.01-2.04-.17-1.85 2.24.06.81.26 2.19.53 3.04l.49 1.55.34-1.17c.19-.64.48-2.02.64-3.06z"
        fill="#ff2116"
      />
      <path
        d="M-20.93 167.84h2.36q1.13 0 1.84.22.71.21 1.19.94.48.73.48 1.76 0 .94-.39 1.62-.39.68-1.06.98-.66.3-2.03.3h-.82v3.73h-1.58zm1.58 1.22v3.33h.78q1.05 0 1.45-.39.41-.39.41-1.27 0-.66-.27-1.06-.27-.41-.59-.5-.31-.1-1.0-.1zm5.51-1.22h2.15q1.56 0 2.49.55.94.55 1.41 1.64.48 1.09.48 2.42 0 1.4-.43 2.5-.43 1.09-1.32 1.76-.88.67-2.52.67h-2.27zm1.58 1.27v7.02h.66q1.38 0 2.0-.95.62-.96.62-2.55 0-3.51-2.62-3.51zm6.47-1.27h5.3v1.27H-4.21v2.85h2.98v1.27h-2.98v4.16h-1.58z"
        fill="#2c2c2c"
        fontFamily="Franklin Gothic Medium Cond"
        letterSpacing="0"
        wordSpacing="4.26000023"
      />
    </g>
  </svg>
);

type DocumentIconProps = {
  mimeType?: string | null | undefined;
  fileName?: string | null | undefined;
  className?: string | undefined;
};

export const DocumentIcon = ({
  mimeType,
  fileName,
  className,
}: DocumentIconProps) => {
  const iconKind = getDocumentIconKind(mimeType, fileName);

  if (iconKind === "pdf") {
    return <PdfIcon className={className} />;
  }

  if (iconKind === "word") {
    return <DocxIcon className={className} />;
  }

  if (iconKind === "rtf") {
    return <RtfIcon className={className} />;
  }

  if (iconKind === "openDocumentText") {
    return <OdtIcon className={className} />;
  }

  if (iconKind === "excel") {
    return <XlsxIcon className={className} />;
  }

  if (iconKind === "powerpoint") {
    return <PptxIcon className={className} />;
  }

  if (iconKind === "openDocumentSheet") {
    return <OdsIcon className={className} />;
  }

  if (iconKind === "csv") {
    return <CsvIcon className={className} />;
  }

  if (iconKind === "image") {
    return <FileImage className={className} />;
  }

  if (iconKind === "email") {
    return <MailIcon className={className} />;
  }

  if (iconKind === "markdown") {
    return <MarkdownIcon className={className} />;
  }

  if (iconKind === "text") {
    return <FileText className={className} />;
  }

  return <File className={className} />;
};
