// The React Native renderers (`*.native.tsx`) are styled with Tailwind
// classes through uniwind, which adds `className` and the `*ClassName`
// colour props to React Native's components. Only those renderers import
// React Native; the web modules never see these props.
/// <reference types="uniwind/types" />
