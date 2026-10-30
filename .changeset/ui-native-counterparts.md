---
"@stll/ui": minor
---

Add React Native renderers beside the web components a phone needs: `Button`, `Text` (new, a role-based text primitive on both platforms), `Loader`, `Input`, `Textarea`, `Switch`, `Sheet`, `Separator`, `MatterIcon` and `StellaWordmarkLatin`. Each export resolves to its native renderer under the `react-native` condition and to the web renderer everywhere else, and both read one shared contract (`<component>.shared.ts`: props, variant tokens, sizes). React Native, uniwind, react-native-svg and lucide-react-native are optional peer dependencies that only the native renderers import.
