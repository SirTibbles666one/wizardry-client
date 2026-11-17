import { describe, expect, it } from "vitest";

import { getContrastRatio, hslToRgb, parseHsl } from "@/lib/colorUtils";
import { builtinThemes, coreToTokens, themePresets, type CoreThemeColors } from "@/themes";

const rgb = (hsl: string) => {
  const { h, s, l } = parseHsl(hsl);
  return hslToRgb(h, s, l);
};
const ratio = (a: string, b: string) => getContrastRatio(rgb(a), rgb(b));

const themes: Array<[string, CoreThemeColors]> = [
  ["builtin light", builtinThemes.light],
  ["builtin dark", builtinThemes.dark],
  ...Object.entries(themePresets).map(([key, preset]): [string, CoreThemeColors] => [key, preset.colors]),
];

describe.each(themes)("%s", (_name, colors) => {
  const t = coreToTokens(colors);

  it("reads body text at WCAG AA", () => {
    expect(ratio(t.foreground, t.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("reads secondary text at WCAG AA on the background and on muted surfaces", () => {
    expect(ratio(t.mutedForeground, t.background)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t.mutedForeground, t.muted)).toBeGreaterThanOrEqual(4.5);
  });

  it("labels a primary button at WCAG AA", () => {
    expect(ratio(t.primaryForeground, t.primary)).toBeGreaterThanOrEqual(4.5);
  });
});

it("puts Wizardry's five themes first, featured", () => {
  const keys = Object.keys(themePresets);
  expect(keys.slice(0, 5)).toEqual(["grove", "moonlit", "lantern", "spellbook", "midnightMoss"]);
  expect(keys.filter((key) => themePresets[key].featured)).toEqual(keys.slice(0, 5));
});

it("keeps Grove as the built-in dark theme", () => {
  expect(themePresets.grove.colors).toEqual(builtinThemes.dark);
});
