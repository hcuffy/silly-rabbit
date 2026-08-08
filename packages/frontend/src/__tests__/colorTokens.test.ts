import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STYLES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css");
const WHITE = "#ffffff";

function readToken(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) {
    throw new Error(`token --${name} not found or not a plain hex literal in styles.css`);
  }
  return match[1];
}

function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const [linearR, linearG, linearB] = [r, g, b].map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linearR + 0.7152 * linearG + 0.0722 * linearB;
}

function contrastRatio(hexA: string, hexB: string): number {
  const luminanceA = relativeLuminance(hexA);
  const luminanceB = relativeLuminance(hexB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

const css = readFileSync(STYLES_PATH, "utf-8");

describe("light-theme token contrast (WCAG 2.1, real relative-luminance math)", () => {
  it.each([
    ["text", "text", 4.5],
    ["text-muted", "text-muted", 4.5],
    ["accent", "accent", 4.5],
    ["accent-hover", "accent-hover", 4.5],
    ["tint-critical-text", "tint-critical-text", 4.5],
    ["tint-pass-text", "tint-pass-text", 4.5],
    ["tint-warning-text", "tint-warning-text", 4.5],
    ["tint-neutral-text", "tint-neutral-text", 4.5],
  ] as const)("--%s clears the %s:1 AA normal-text bar on white", (token, _label, minimum) => {
    const ratio = contrastRatio(readToken(css, token), WHITE);
    expect(ratio).toBeGreaterThanOrEqual(minimum);
  });

  it("--button--primary white-on-accent text clears the 4.5:1 AA bar", () => {
    const ratio = contrastRatio(readToken(css, "accent"), WHITE);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("--accent-soft fails AA as a text color, confirming it must stay decorative-only", () => {
    const ratio = contrastRatio(readToken(css, "accent-soft"), WHITE);
    expect(ratio).toBeLessThan(4.5);
  });

  it("--accent clears the 3:1 AA non-text (focus ring / UI component) bar on white", () => {
    const ratio = contrastRatio(readToken(css, "accent"), WHITE);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it("locked spec hex values are applied verbatim (docs/light-theme-redesign-spec.md §5)", () => {
    expect(readToken(css, "bg")).toBe("#ffffff");
    expect(readToken(css, "surface")).toBe("#ffffff");
    expect(readToken(css, "text")).toBe("#14181f");
    expect(readToken(css, "text-muted")).toBe("#5b6472");
    expect(readToken(css, "accent")).toBe("#0f766e");
    expect(readToken(css, "accent-hover")).toBe("#115e59");
    expect(readToken(css, "accent-soft")).toBe("#14b8a6");
    expect(readToken(css, "tint-critical-text")).toBe("#dc2626");
    expect(readToken(css, "tint-pass-text")).toBe("#15803d");
    expect(readToken(css, "tint-warning-text")).toBe("#b45309");
    expect(readToken(css, "tint-neutral-text")).toBe("#64748b");
  });

  it("locked radius scale is applied verbatim (docs/light-theme-redesign-spec.md §6)", () => {
    expect(css).toContain("--radius-sm: 8px;");
    expect(css).toContain("--radius-md: 12px;");
    expect(css).toContain("--radius-lg: 16px;");
    expect(css).toContain("--radius-pill: 999px;");
  });

  it("locked spacing scale is applied verbatim (docs/light-theme-redesign-spec.md §8)", () => {
    expect(css).toContain("--space-1: 4px;");
    expect(css).toContain("--space-2: 8px;");
    expect(css).toContain("--space-3: 12px;");
    expect(css).toContain("--space-4: 16px;");
    expect(css).toContain("--space-5: 24px;");
    expect(css).toContain("--space-6: 32px;");
  });
});

describe("button system consolidation", () => {
  it("removes the two duplicated per-form button rule blocks", () => {
    expect(css).not.toMatch(/\.new-run-form button \{/);
    expect(css).not.toMatch(/\.login-screen__form button \{/);
  });

  it("defines one shared .button base plus primary/secondary/destructive variants", () => {
    expect(css).toMatch(/\.button \{/);
    expect(css).toMatch(/\.button--primary \{/);
    expect(css).toMatch(/\.button--secondary \{/);
    expect(css).toMatch(/\.button--destructive \{/);
    expect(css).toMatch(/border-radius: var\(--radius-pill\);/);
    expect(css).toMatch(/padding: var\(--space-3\) var\(--space-5\);/);
  });

  it("removes the now-dead .button-danger class — every former consumer moved to .button--destructive", () => {
    expect(css).not.toMatch(/\.button-danger/);
  });
});

function compositeOverWhite(rgbaTriplet: [number, number, number], alpha: number): string {
  const [r, g, b] = rgbaTriplet;
  const toHexByte = (channel: number) =>
    Math.round(channel * alpha + 255 * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

describe("phase 2 — card gradient tints still clear AA for the text sitting on them", () => {
  it.each([
    ["tint-critical-bg", "text"],
    ["tint-pass-bg", "text"],
    ["tint-warning-bg", "text"],
    ["tint-neutral-bg", "text"],
    ["tint-critical-bg", "text-muted"],
    ["tint-pass-bg", "text-muted"],
    ["tint-warning-bg", "text-muted"],
    ["tint-neutral-bg", "text-muted"],
  ] as const)(
    "FindingCard body text (--%s) on the --%s verdict-gradient's most saturated stop clears 4.5:1",
    (bgToken, textToken) => {
      const ratio = contrastRatio(readToken(css, textToken), readToken(css, bgToken));
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("CycleCard's accent-tint-bg gradient stop (8% teal over white) still clears 4.5:1 for --text and --text-muted", () => {
    // --accent-tint-bg is rgba(15, 118, 110, 0.08), locked in phase 1 — composited over white here
    // since CSS custom properties can't be read as computed alpha-blended color from a static file.
    const compositedAccentTint = compositeOverWhite([15, 118, 110], 0.08);
    expect(contrastRatio(readToken(css, "text"), compositedAccentTint)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readToken(css, "text-muted"), compositedAccentTint)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("phase 2 — CycleCard and FindingCard styled per spec, plain tables stay flat", () => {
  it("CycleCard gets real card styling (radius-md, space-4 padding, accent-tint gradient) — was a bare unstyled div before", () => {
    expect(css).toMatch(/\.cycle-card \{[^}]*border-radius: var\(--radius-md\);/s);
    expect(css).toMatch(/\.cycle-card \{[^}]*padding: var\(--space-4\);/s);
    expect(css).toMatch(/\.cycle-card \{[^}]*background: linear-gradient\(135deg, var\(--accent-tint-bg\), var\(--surface\)\);/s);
  });

  it("FindingCard gets a verdict-tinted gradient modifier per verdict, reusing the locked §4 semantic tint-bg tokens", () => {
    expect(css).toMatch(/\.finding-card--verdict-regression \{[^}]*var\(--tint-critical-bg\)/s);
    expect(css).toMatch(/\.finding-card--verdict-intended_change \{[^}]*var\(--tint-pass-bg\)/s);
    expect(css).toMatch(/\.finding-card--verdict-needs_human \{[^}]*var\(--tint-warning-bg\)/s);
    expect(css).toMatch(/\.finding-card--verdict-known \{[^}]*var\(--tint-neutral-bg\)/s);
  });

  it("plain tabular views (run-history, check-outcomes) stay flat — no gradient background", () => {
    const runHistoryBlock = css.match(/\.run-history \{[^}]*\}/s)?.[0] ?? "";
    const checkOutcomesBlock = css.match(/\.check-outcomes__table \{[^}]*\}/s)?.[0] ?? "";
    expect(runHistoryBlock).not.toMatch(/gradient/);
    expect(checkOutcomesBlock).not.toMatch(/gradient/);
  });
});

describe("live-review bugfix round — real spacing between cards and sections", () => {
  it("CycleCard instances get a real gap in the cycles list (was flush, no rule existed at all)", () => {
    expect(css).toMatch(/\.cycle-list__cards \{[^}]*gap: var\(--space-4\);/s);
  });

  it("Settings page sections (target profiles vs NavMap) get a real visual boundary, not just whitespace", () => {
    const navMapBlock = css.match(/\.nav-map-panel \{[^}]*\}/s)?.[0] ?? "";
    expect(navMapBlock).toMatch(/margin-top: var\(--space-6\);/);
    expect(navMapBlock).toMatch(/border-top: 1px solid var\(--border\);/);
  });

  it("New Run / New Explorer Run forms get a real card boundary (border+radius+padding), not a bare flex row", () => {
    const newRunFormBlock = css.match(/\.new-run-form \{[^}]*\}/s)?.[0] ?? "";
    expect(newRunFormBlock).toMatch(/border: 1px solid var\(--border\);/);
    expect(newRunFormBlock).toMatch(/border-radius: var\(--radius-md\);/);
    expect(newRunFormBlock).toMatch(/padding: var\(--space-4\);/);
  });
});

describe("live-review bugfix round — required-field inline validation styling", () => {
  it("defines a visible required-marker style and a real invalid-state border color, scoped to form fields", () => {
    expect(css).toMatch(/\.field-required \{[^}]*color: var\(--tint-critical-text\);/s);
    expect(css).toContain(".new-run-form textarea:user-invalid,");
    expect(css).toMatch(/:user-invalid[^{]*\{\s*border-color: var\(--tint-critical-text\);/s);
  });
});

describe("live-review bugfix round #2 — NavMap input matches the shared form-input styling", () => {
  it("the base-url input in NavMapPanel is styled by the same rule block as every other form input, " +
    "not left bare — it was missing from the shared selector group entirely (no .new-run-form ancestor, " +
    "since the crawl-result table below it can't be squeezed to the form's 480px max-width)", () => {
    const sharedInputBlock = css.match(/\.new-run-form textarea,\n\.new-run-form input,\n\.new-run-form select,\n\.nav-map-panel input \{[^}]*\}/);
    expect(sharedInputBlock).not.toBeNull();
    expect(sharedInputBlock?.[0]).toMatch(/border: 1px solid var\(--border\);/);
    expect(sharedInputBlock?.[0]).toMatch(/border-radius: var\(--radius-sm\);/);
    expect(sharedInputBlock?.[0]).toMatch(/background: var\(--surface\);/);
  });

  it("the NavMap input also gets the same focus-visible outline as every other form input", () => {
    expect(css).toMatch(/\.new-run-form textarea:focus-visible,\n\.new-run-form input:focus-visible,\n\.nav-map-panel input:focus-visible \{/);
  });
});

describe("live-review bugfix round #2 — FieldHint tooltip contrast (real audit, not eyeballed)", () => {
  it("the tooltip's background/text tokens (as written in .field-hint::after) resolve to real hex " +
    "and clear 4.5:1 AA — audit conclusion: both already reference light-theme tokens (var(--surface), " +
    "var(--text)), giving 17.8:1 in the current stylesheet; this test locks that in as a regression guard", () => {
    const tooltipBlock = css.match(/\.field-hint::after \{[^}]*\}/s)?.[0] ?? "";
    const backgroundMatch = tooltipBlock.match(/background: var\(--([\w-]+)\);/);
    const colorMatch = tooltipBlock.match(/\n {2}color: var\(--([\w-]+)\);/);
    expect(backgroundMatch).not.toBeNull();
    expect(colorMatch).not.toBeNull();

    const backgroundHex = readToken(css, backgroundMatch![1]);
    const textHex = readToken(css, colorMatch![1]);
    expect(contrastRatio(textHex, backgroundHex)).toBeGreaterThanOrEqual(4.5);
  });

  it("opacity is the only animated property on the tooltip — background/color are never mid-transition, " +
    "so there is no possible opacity-vs-background timing race in the current rule", () => {
    const tooltipBlock = css.match(/\.field-hint::after \{[^}]*\}/s)?.[0] ?? "";
    const transitionMatch = tooltipBlock.match(/transition: ([^;]+);/);
    expect(transitionMatch?.[1]).toBe("opacity 0.1s ease");
  });
});
