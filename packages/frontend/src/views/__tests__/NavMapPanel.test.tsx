import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavMapPanel } from "../NavMapPanel.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const PROFILE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Release",
  baseUrl: "https://release.example.com",
  allowedDomains: ["release.example.com"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const EXISTING_NAV_MAP = {
  id: "22222222-2222-4222-8222-222222222222",
  baseUrl: "https://release.example.com",
  entries: [
    { role: "link", label: "Locations", normalizedUrl: "https://release.example.com/locations", isStale: false },
    { role: "listitem", label: "Detail", parentLabel: "Locations", isStale: true },
  ],
  crawledAt: new Date().toISOString(),
  crawlDurationMs: 4200,
};

function stubFetch(handlers: { navMap?: () => Response; crawl?: () => Response; del?: () => Response }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/target-profiles/active")) {
        return Promise.resolve(jsonResponse({ profileId: PROFILE.id }));
      }
      if (url.endsWith("/target-profiles")) {
        return Promise.resolve(jsonResponse([PROFILE]));
      }
      if (url.includes("/nav-map/crawl")) {
        return Promise.resolve(handlers.crawl?.() ?? jsonResponse({ error: "no crawl handler" }, 500));
      }
      if (url.includes("/nav-map") && init?.method === "DELETE") {
        return Promise.resolve(handlers.del?.() ?? new Response(null, { status: 204 }));
      }
      if (url.includes("/nav-map")) {
        return Promise.resolve(handlers.navMap?.() ?? jsonResponse({ error: "no nav-map handler" }, 500));
      }
      return Promise.resolve(jsonResponse({ error: `unexpected url in test: ${url}` }, 500));
    }),
  );
}

describe("NavMapPanel (Settings page)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults the base URL input to the active target profile's baseUrl and loads its existing NavMap", async () => {
    stubFetch({ navMap: () => jsonResponse(EXISTING_NAV_MAP) });
    renderWithClient(<NavMapPanel />);

    await waitFor(() => expect(screen.getByLabelText("Target base URL")).toHaveValue(PROFILE.baseUrl));

    expect(await screen.findByText(/2 entries mapped, crawled/)).toBeInTheDocument();
    expect(screen.getByText("Locations")).toBeInTheDocument();
    expect(screen.getByText("Locations › Detail")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText("Fresh")).toBeInTheDocument();
  });

  it("shows a clear no-map-yet message when GET /nav-map 404s for the active profile's baseUrl", async () => {
    stubFetch({ navMap: () => jsonResponse({ error: "no nav map for this baseUrl" }, 404) });
    renderWithClient(<NavMapPanel />);

    expect(await screen.findByText("No NavMap yet for this baseUrl. Click Crawl to build one.")).toBeInTheDocument();
  });

  it(
    "Crawl shows an in-progress message while the (delayed, real-crawls-are-slow-shaped) request is " + "in flight, then the result on success",
    async () => {
      stubFetch({
        navMap: () => jsonResponse({ error: "no nav map" }, 404),
        crawl: () => jsonResponse(EXISTING_NAV_MAP),
      });
      const user = userEvent.setup();
      renderWithClient(<NavMapPanel />);
      await screen.findByText("No NavMap yet for this baseUrl. Click Crawl to build one.");

      const fetchMock = vi.mocked(fetch);
      const instantImplementation = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (...arguments_) => {
        const [url] = arguments_;
        if (typeof url === "string" && url.includes("/nav-map/crawl")) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return instantImplementation(...arguments_);
      });

      await user.click(screen.getByRole("button", { name: "Crawl" }));

      expect(await screen.findByRole("status")).toHaveTextContent(/can take a while/);
      expect(await screen.findByText("Locations")).toBeInTheDocument();
    },
  );

  it("a crawl failure (e.g. destructive-guard rejection, unreachable target) shows a clear error", async () => {
    stubFetch({
      navMap: () => jsonResponse({ error: "no nav map" }, 404),
      crawl: () => jsonResponse({ error: "host is not on the domain allowlist" }, 400),
    });
    const user = userEvent.setup();
    renderWithClient(<NavMapPanel />);
    await screen.findByText("No NavMap yet for this baseUrl. Click Crawl to build one.");

    await user.click(screen.getByRole("button", { name: "Crawl" }));

    expect(await screen.findByText(/Crawl failed: host is not on the domain allowlist/)).toBeInTheDocument();
  });

  it("Delete map asks for confirmation, and only calls DELETE when confirmed", async () => {
    stubFetch({ navMap: () => jsonResponse(EXISTING_NAV_MAP) });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderWithClient(<NavMapPanel />);
    await screen.findByText("Locations");

    await user.click(screen.getByRole("button", { name: "Delete map" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByText("Locations")).toBeInTheDocument();
  });

  it("Delete map really removes the map from view once confirmed", async () => {
    let deleted = false;
    stubFetch({
      navMap: () => (deleted ? jsonResponse({ error: "no nav map" }, 404) : jsonResponse(EXISTING_NAV_MAP)),
      del: () => {
        deleted = true;
        return new Response(null, { status: 204 });
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderWithClient(<NavMapPanel />);
    await screen.findByText("Locations");

    await user.click(screen.getByRole("button", { name: "Delete map" }));

    await waitFor(() => expect(screen.queryByText("Locations")).not.toBeInTheDocument());
  });
});
