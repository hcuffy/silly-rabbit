import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TargetProfileList } from "../TargetProfileList.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const PROFILE_A = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Release",
  baseUrl: "https://release.example.com",
  allowedDomains: ["release.example.com"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("TargetProfileList (Settings page)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/target-profiles/active")) return Promise.resolve(jsonResponse({ profileId: PROFILE_A.id }));
        if (url.endsWith("/target-profiles")) return Promise.resolve(jsonResponse([PROFILE_A]));
        return Promise.resolve(jsonResponse({ error: `unexpected url in test: ${url}` }, 500));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the profile with an Active badge, matching the active-profile-id endpoint", async () => {
    renderWithClient(<TargetProfileList />);

    expect(await screen.findByText("Release")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("the response body's absence of email/password never surfaces a credential value anywhere on the page", async () => {
    renderWithClient(<TargetProfileList />);
    await screen.findByText("Release");

    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("clicking Edit opens the form pre-filled with non-credential fields, credential inputs blank", async () => {
    const user = userEvent.setup();
    renderWithClient(<TargetProfileList />);
    await screen.findByText("Release");

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByLabelText("Name")).toHaveValue("Release");
    expect(screen.getByLabelText("Login email")).toHaveValue("");
    expect(screen.getByLabelText("Login password")).toHaveValue("");
  });

  it("clicking + New target profile shows the create form", async () => {
    const user = userEvent.setup();
    renderWithClient(<TargetProfileList />);
    await screen.findByText("Release");

    await user.click(screen.getByRole("button", { name: "+ New target profile" }));

    expect(screen.getByRole("heading", { name: "New target profile" })).toBeInTheDocument();
  });
});
