import type { Finding } from "@silly-rabbit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FindingCard } from "../FindingCard.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    runId: "run-1",
    screenId: "screen-1",
    type: "STATE_DIVERGENCE",
    verdict: "REGRESSION",
    severity: "HIGH",
    reasoning: "button removed",
    confidence: 0.9,
    evidence: { ariaSnapshot: '- heading "Locations"' },
    dedupKey: "dedup-1",
    status: "NEW",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (nextUi: React.ReactElement) => <QueryClientProvider client={queryClient}>{nextUi}</QueryClientProvider>;
  const rendered = render(wrap(ui));
  return { ...rendered, rerender: (nextUi: React.ReactElement) => rendered.rerender(wrap(nextUi)) };
}

describe("FindingCard (frontend-spec §5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders type/verdict/severity/confidence/reasoning", () => {
    renderWithClient(
      <ul>
        <FindingCard finding={makeFinding()} />
      </ul>,
    );

    expect(screen.getByText("STATE_DIVERGENCE")).toBeInTheDocument();
    expect(screen.getByText("REGRESSION")).toBeInTheDocument();
    expect(screen.getByText("HIGH")).toBeInTheDocument();
    expect(screen.getByText("confidence 90%")).toBeInTheDocument();
    expect(screen.getByText("button removed")).toBeInTheDocument();
  });

  it("shows an Opus badge only when escalatedToOpus is true — never for undefined or false", () => {
    const { rerender } = renderWithClient(
      <ul>
        <FindingCard finding={makeFinding({ escalatedToOpus: undefined })} />
      </ul>,
    );
    expect(screen.queryByText("Opus")).not.toBeInTheDocument();

    rerender(
      <ul>
        <FindingCard finding={makeFinding({ escalatedToOpus: false })} />
      </ul>,
    );
    expect(screen.queryByText("Opus")).not.toBeInTheDocument();

    rerender(
      <ul>
        <FindingCard finding={makeFinding({ escalatedToOpus: true })} />
      </ul>,
    );
    expect(screen.getByText("Opus")).toBeInTheDocument();
  });

  it("renders explanation when present (judge infra-failure attribution)", () => {
    renderWithClient(
      <ul>
        <FindingCard finding={makeFinding({ explanation: "network down" })} />
      </ul>,
    );
    expect(screen.getByText("network down")).toBeInTheDocument();
  });

  it("shows a DISMISSED status badge only when the finding's status is DISMISSED", () => {
    const { rerender } = renderWithClient(
      <ul>
        <FindingCard finding={makeFinding({ status: "NEW" })} />
      </ul>,
    );
    expect(screen.queryByText("DISMISSED")).not.toBeInTheDocument();

    rerender(
      <ul>
        <FindingCard finding={makeFinding({ status: "DISMISSED" })} />
      </ul>,
    );
    expect(screen.getByText("DISMISSED")).toBeInTheDocument();
  });

  it("applies the active class only when isActive is true", () => {
    const { container, rerender } = renderWithClient(
      <ul>
        <FindingCard finding={makeFinding()} />
      </ul>,
    );
    expect(container.querySelector(".finding-card--active")).toBeNull();

    rerender(
      <ul>
        <FindingCard finding={makeFinding()} isActive />
      </ul>,
    );
    expect(container.querySelector(".finding-card--active")).not.toBeNull();
  });

  it("shows a screenshot thumbnail, linked to the full image, only when screenshotPath is present", () => {
    const { rerender } = renderWithClient(
      <ul>
        <FindingCard finding={makeFinding({ screenshotPath: undefined })} />
      </ul>,
    );
    expect(screen.queryByAltText("Screenshot at time of finding")).not.toBeInTheDocument();

    rerender(
      <ul>
        <FindingCard finding={makeFinding({ screenshotPath: "/tmp/screenshots/x.png" })} />
      </ul>,
    );
    const thumbnail = screen.getByAltText("Screenshot at time of finding");
    expect(thumbnail).toHaveAttribute("src", expect.stringContaining("/findings/11111111-1111-1111-1111-111111111111/screenshot"));
    expect(thumbnail.closest("a")).toHaveAttribute(
      "href",
      expect.stringContaining("/findings/11111111-1111-1111-1111-111111111111/screenshot"),
    );
  });

  it("never requests a pixel-diff when before/after screenshot paths aren't both present", () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ pixelDiffScore: 0.5 })));
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(
      <ul>
        <FindingCard finding={makeFinding({ screenshotPath: "/tmp/screenshots/x.png", beforeScreenshotPath: undefined })} />
      </ul>,
    );

    expect(screen.queryByText(/pixel diff/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a pixel-diff percentage fetched from the pixel-diff route when both paths are present — informational only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/pixel-diff")) return Promise.resolve(jsonResponse({ pixelDiffScore: 0.427 }));
        return Promise.resolve(jsonResponse({}, 404));
      }),
    );

    renderWithClient(
      <ul>
        <FindingCard
          finding={makeFinding({
            screenshotPath: "/tmp/screenshots/x.png",
            beforeScreenshotPath: "/tmp/screenshots/baseline-screen-1.png",
          })}
        />
      </ul>,
    );

    expect(await screen.findByText("pixel diff 42.7%")).toBeInTheDocument();
  });

  it("renders EvidenceDiff only when both ariaSnapshot and ariaSnapshotBefore are present, else falls back to the single-blob summary", () => {
    const { container, rerender } = renderWithClient(
      <ul>
        <FindingCard finding={makeFinding({ evidence: { ariaSnapshot: '- heading "Locations"' } })} />
      </ul>,
    );
    expect(container.querySelector(".evidence-diff")).toBeNull();
    expect(screen.getByText(/aria: - heading "Locations"/)).toBeInTheDocument();

    rerender(
      <ul>
        <FindingCard
          finding={makeFinding({
            evidence: { ariaSnapshot: '- heading "Vehicles"', ariaSnapshotBefore: '- heading "Locations"' },
          })}
        />
      </ul>,
    );
    expect(container.querySelector(".evidence-diff")).not.toBeNull();
    expect(screen.queryByText(/^aria: /)).not.toBeInTheDocument();
  });

  it("shows a download-repro link only when reproSpecPath is present", () => {
    const { rerender } = renderWithClient(
      <ul>
        <FindingCard finding={makeFinding({ reproSpecPath: undefined })} />
      </ul>,
    );
    expect(screen.queryByText("Download repro")).not.toBeInTheDocument();

    rerender(
      <ul>
        <FindingCard finding={makeFinding({ reproSpecPath: "/tmp/repro-specs/x.spec.ts" })} />
      </ul>,
    );
    const link = screen.getByText("Download repro");
    expect(link).toHaveAttribute("href", expect.stringContaining("/findings/11111111-1111-1111-1111-111111111111/repro"));
  });
});
