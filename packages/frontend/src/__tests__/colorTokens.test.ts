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
    expect(css).toMatch(/padding: 0\.75rem 1\.5rem;/);
  });
});
