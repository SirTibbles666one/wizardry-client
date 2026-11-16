// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { builtinThemes, coreToTokens, themePresets, toThemeVar, type CoreThemeColors } from "@/themes";

const script = readFileSync(resolve(process.cwd(), "public/theme.js"), "utf8");

/** Runs the pre-paint script against a stored theme and reads back the variables it set. */
function prepaint(config: object): Record<string, string> {
  localStorage.setItem("armada:app-config", JSON.stringify(config));
  new Function(script)();
  const css = document.getElementById("theme-vars")?.textContent ?? "";
  const vars: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/(--[\w-]+):([^;]+);/g)) vars[name] = value.trim();
  return vars;
}

/** The two derivations round differently by a tenth; compare the numbers, not the strings. */
function closeTo(a: string, b: string): boolean {
  const x = a.replace(/%/g, "").split(/\s+/).map(Number);
  const y = b.replace(/%/g, "").split(/\s+/).map(Number);
  return x.length === 3 && x.every((v, i) => Math.abs(v - y[i]) <= 0.15);
}

afterEach(() => {
  localStorage.clear();
  document.getElementById("theme-vars")?.remove();
});

describe("public/theme.js", () => {
  it("paints the same built-in dark and light themes as src/themes.ts", () => {
    for (const mode of ["dark", "light"] as const) {
      const vars = prepaint({ theme: mode });
      expect(vars["--background"]).toBe(builtinThemes[mode].background);
      expect(vars["--primary"]).toBe(builtinThemes[mode].primary);
    }
  });

  const cases: Array<[string, CoreThemeColors]> = Object.entries(themePresets).map(([k, p]) => [k, p.colors]);
  it.each(cases)("derives %s's text colours as the app does", (_name, colors) => {
    const vars = prepaint({ theme: "custom", customTheme: { colors } });
    const tokens = coreToTokens(colors);
    for (const key of ["primaryForeground", "mutedForeground", "muted", "card"] as const) {
      expect(closeTo(vars[toThemeVar(key)], tokens[key]), `${key}: ${vars[toThemeVar(key)]} vs ${tokens[key]}`).toBe(true);
    }
  });
});
