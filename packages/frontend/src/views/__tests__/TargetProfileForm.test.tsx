import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SafeTargetProfile } from "../../lib/targetProfileApiClient.js";
import { TargetProfileForm } from "../TargetProfileForm.js";

const EXISTING_PROFILE: SafeTargetProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Release",
  baseUrl: "https://release.example.com",
  loginUrl: "https://release.example.com/login",
  emailSelector: "#email",
  passwordSelector: "#password",
  submitSelector: "#submit",
  allowedDomains: ["release.example.com"],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("TargetProfileForm (Settings page — target profile create/edit)", () => {
  it("create mode: submitting builds a payload with allowedDomains split from the comma-separated input", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TargetProfileForm mode="create" isSubmitting={false} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Name"), "Dev");
    await user.type(screen.getByLabelText("Base URL"), "https://dev.example.com");
    await user.type(screen.getByLabelText("Allowed domains"), "dev.example.com, other.example.com");
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Dev",
        baseUrl: "https://dev.example.com",
        allowedDomains: ["dev.example.com", "other.example.com"],
      }),
    );
  });

  it("edit mode pre-fills every non-credential field from `initial`, but email/password always start " +
    "blank — the type itself (SafeTargetProfile) never carries a credential value to pre-fill from", () => {
    render(
      <TargetProfileForm mode="edit" initial={EXISTING_PROFILE} isSubmitting={false} onSubmit={vi.fn()} />,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Release");
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://release.example.com");
    expect(screen.getByLabelText("Allowed domains")).toHaveValue("release.example.com");
    expect(screen.getByLabelText("Login email")).toHaveValue("");
    expect(screen.getByLabelText("Login password")).toHaveValue("");
  });

  it("edit mode: submitting with blank credential fields omits email/password from the payload " +
    "entirely — not empty strings — so the backend's patch semantics leave them unchanged", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <TargetProfileForm mode="edit" initial={EXISTING_PROFILE} isSubmitting={false} onSubmit={onSubmit} />,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const payload = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("password");
  });

  it("edit mode: typing a new password includes it in the payload", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <TargetProfileForm mode="edit" initial={EXISTING_PROFILE} isSubmitting={false} onSubmit={onSubmit} />,
    );

    await user.type(screen.getByLabelText("Login password"), "new-password");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ password: "new-password" }));
  });

  it("shows a validation error and does not call onSubmit when a required field is missing", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TargetProfileForm mode="create" isSubmitting={false} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Create profile" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("Cancel calls onCancel, not onSubmit", async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TargetProfileForm mode="create" isSubmitting={false} onSubmit={onSubmit} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
