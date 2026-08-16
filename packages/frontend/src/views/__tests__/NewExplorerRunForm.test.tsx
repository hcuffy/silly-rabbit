import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewExplorerRunForm } from "../NewExplorerRunForm.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("NewExplorerRunForm (D8 dashboard trigger UI)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits the form, POSTs /explorer/runs, and calls onCreated with the new run id", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({ runId: "run-456", status: "PENDING" }, 202));
      }
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    const user = userEvent.setup();

    renderWithClient(<NewExplorerRunForm onCreated={onCreated} />);

    await user.type(screen.getByLabelText("Feature name"), "locations");
    await user.type(screen.getByLabelText("Section description"), "the locations flow");
    await user.type(screen.getByLabelText("Target base URL"), "https://dev.rabbit.example");
    await user.click(screen.getByRole("button", { name: "Run explorer" }));

    expect(await screen.findByRole("button", { name: "Run explorer" })).toBeEnabled();
    expect(onCreated).toHaveBeenCalledWith("run-456");
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall?.[0]).toContain("/explorer/runs");
    expect(JSON.parse(postCall?.[1]?.body as string)).toEqual({
      featureId: "locations",
      sectionDescription: "the locations flow",
      targetBaseUrl: "https://dev.rabbit.example",
    });
  });

  it("shows a validation error and never POSTs when targetBaseUrl is invalid", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithClient(<NewExplorerRunForm onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText("Feature name"), "locations");
    await user.type(screen.getByLabelText("Section description"), "the locations flow");
    await user.type(screen.getByLabelText("Target base URL"), "not-a-url");
    await user.click(screen.getByRole("button", { name: "Run explorer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/valid URL/i);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it(
    "marks Feature name, Section description, and Target base URL required (real, non-optional " + "fields per CreateExplorerRunInputSchema)",
    () => {
      renderWithClient(<NewExplorerRunForm onCreated={vi.fn()} />);

      expect(screen.getByLabelText("Feature name")).toBeRequired();
      expect(screen.getByLabelText("Section description")).toBeRequired();
      expect(screen.getByLabelText("Target base URL")).toBeRequired();
    },
  );

  it("suppresses native validation bubbles (noValidate) — required stays for screen readers", () => {
    const { container } = renderWithClient(<NewExplorerRunForm onCreated={vi.fn()} />);

    expect(container.querySelector("form")).toHaveAttribute("novalidate");
  });

  it(
    "empty required fields on submit: shows real inline error text for each, marks them aria-invalid, " +
      "and focuses the first invalid field (Feature name, first in document order)",
    async () => {
      const user = userEvent.setup();
      renderWithClient(<NewExplorerRunForm onCreated={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Run explorer" }));

      expect(await screen.findByText("Feature name is required.")).toBeInTheDocument();
      expect(screen.getByText("Section description is required.")).toBeInTheDocument();
      expect(screen.getByText("Target base URL is required.")).toBeInTheDocument();
      expect(screen.getByLabelText("Feature name")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText("Feature name")).toHaveFocus();
    },
  );

  it("picking an example description fills the textarea (onboarding-friction fix)", async () => {
    const user = userEvent.setup();
    renderWithClient(<NewExplorerRunForm onCreated={vi.fn()} />);

    const picker = screen.getByLabelText("Insert an example section description");
    await user.selectOptions(picker, "billing and invoices");

    expect(screen.getByLabelText("Section description")).toHaveValue("billing and invoices");
  });
});
