import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewRunForm } from "../NewRunForm.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("NewRunForm (frontend-spec §5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits the form, POSTs /runs, and calls onCreated with the new run id", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ runId: "run-123", status: "PENDING" }, 202));
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    const user = userEvent.setup();

    renderWithClient(<NewRunForm onCreated={onCreated} />);

    await user.type(screen.getByLabelText("Charter"), "test the locations flow");
    await user.type(screen.getByLabelText("Target base URL"), "https://dev.rabbit.example");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByRole("button", { name: "Run" })).toBeEnabled();
    expect(onCreated).toHaveBeenCalledWith("run-123");
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall?.[0]).toContain("/runs");
  });

  it("shows a validation error and never POSTs when targetBaseUrl is invalid", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithClient(<NewRunForm onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("Charter"), "test the locations flow");
    await user.type(screen.getByLabelText("Target base URL"), "not-a-url");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/valid URL/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("marks Charter and Target base URL required (real, non-optional fields per CreateRunInputSchema)", () => {
    renderWithClient(<NewRunForm onCreated={vi.fn()} />);

    expect(screen.getByLabelText("Charter")).toBeRequired();
    expect(screen.getByLabelText("Target base URL")).toBeRequired();
  });

  it("suppresses native validation bubbles (noValidate) — required stays for screen readers, the " +
    "browser no longer intercepts submission or shows its own illegible bubble UI", () => {
    const { container } = renderWithClient(<NewRunForm onCreated={vi.fn()} />);

    expect(container.querySelector("form")).toHaveAttribute("novalidate");
  });

  it("empty required fields on submit: shows real inline error text (not hover-dependent), marks the " +
    "fields aria-invalid, and focuses the first invalid field (Charter, before Target base URL)", async () => {
    const user = userEvent.setup();
    renderWithClient(<NewRunForm onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Charter is required.")).toBeInTheDocument();
    expect(screen.getByText("Target base URL is required.")).toBeInTheDocument();
    expect(screen.getByLabelText("Charter")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Charter")).toHaveFocus();
  });

  it("picking an example charter fills the textarea (onboarding-friction fix)", async () => {
    const user = userEvent.setup();
    renderWithClient(<NewRunForm onCreated={vi.fn()} />);

    const picker = screen.getByLabelText("Insert an example charter");
    await user.selectOptions(
      picker,
      "Add a new item to the cart, proceed to checkout, and confirm the order summary shows the correct total.",
    );

    expect(screen.getByLabelText("Charter")).toHaveValue(
      "Add a new item to the cart, proceed to checkout, and confirm the order summary shows the correct total.",
    );
  });
});

describe("NewRunForm — cycle-select pre-fill (run-cycles-spec.md §5.1 CONFIRM-1, locked)", () => {
  const CYCLE_ID = "55555555-5555-4555-8555-555555555555";

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("pre-fills the cycle <select> from the browser's last-used cycle, but leaves it fully changeable — " +
    "not a silent default, an explicit pre-filled choice", async () => {
    window.localStorage.setItem("silly-rabbit:last-used-cycle-id", CYCLE_ID);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse([
            {
              id: CYCLE_ID,
              name: "Release 3.22",
              kind: "release",
              status: "active",
              isDefault: false,
              runCounter: 1,
              sessionReplayRunCounter: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ]),
        ),
      ),
    );

    renderWithClient(<NewRunForm onCreated={vi.fn()} />);

    await screen.findByRole("option", { name: "Release 3.22" });
    const select: HTMLSelectElement = screen.getByLabelText("Cycle");
    expect(select.value).toBe(CYCLE_ID);

    const user = userEvent.setup();
    await user.selectOptions(select, "");
    expect(select.value).toBe("");
  });

  it("with no last-used cycle recorded (fresh browser), the select starts unselected", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([]))));

    renderWithClient(<NewRunForm onCreated={vi.fn()} />);

    const select: HTMLSelectElement = await screen.findByLabelText("Cycle");
    expect(select.value).toBe("");
  });
});
