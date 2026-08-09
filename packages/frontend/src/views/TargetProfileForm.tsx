import { Fragment, useState, type FormEvent } from "react";
import { FieldLabel } from "../components/FieldLabel.js";
import { findEmptyRequiredFields, focusFirstInvalidField } from "../lib/requiredFieldValidation.js";
import { TargetProfileWriteInputSchema, type SafeTargetProfile, type TargetProfileWriteInput } from "../lib/targetProfileApiClient.js";

const NAME_REQUIRED_MESSAGE = "Name is required.";
const BASE_URL_REQUIRED_MESSAGE = "Base URL is required.";
const ALLOWED_DOMAINS_REQUIRED_MESSAGE = "At least one allowed domain is required.";

interface TargetProfileFormProperties {
  mode: "create" | "edit";
  initial?: SafeTargetProfile;
  onSubmit: (payload: TargetProfileWriteInput) => void;
  onCancel?: () => void;
  isSubmitting: boolean;
  submitError?: string;
}

export function TargetProfileForm(
  { mode, initial, onSubmit, onCancel, isSubmitting, submitError }: TargetProfileFormProperties,
) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [loginUrl, setLoginUrl] = useState(initial?.loginUrl ?? "");
  const [emailSelector, setEmailSelector] = useState(initial?.emailSelector ?? "");
  const [passwordSelector, setPasswordSelector] = useState(initial?.passwordSelector ?? "");
  const [submitSelector, setSubmitSelector] = useState(initial?.submitSelector ?? "");
  const [nextSelector, setNextSelector] = useState(initial?.nextSelector ?? "");
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs?.toString() ?? "");
  const [locationsPath, setLocationsPath] = useState(initial?.locationsPath ?? "");
  const [allowedDomains, setAllowedDomains] = useState((initial?.allowedDomains ?? []).join(", "));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [validationError, setValidationError] = useState<string | undefined>(undefined);
  const [invalidFields, setInvalidFields] = useState<Set<string>>(new Set());

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const requiredFields = [
      { key: "name", id: "tp-name", value: name },
      { key: "baseUrl", id: "tp-baseUrl", value: baseUrl },
      { key: "allowedDomains", id: "tp-allowedDomains", value: allowedDomains },
    ];
    const emptyFields = findEmptyRequiredFields(requiredFields);
    if (emptyFields.size > 0) {
      setInvalidFields(emptyFields);
      focusFirstInvalidField(requiredFields, emptyFields);
      return;
    }
    setInvalidFields(new Set());

    const payload = {
      name,
      baseUrl,
      loginUrl: loginUrl || undefined,
      emailSelector: emailSelector || undefined,
      passwordSelector: passwordSelector || undefined,
      submitSelector: submitSelector || undefined,
      nextSelector: nextSelector || undefined,
      timeoutMs: timeoutMs ? Number(timeoutMs) : undefined,
      locationsPath: locationsPath || undefined,
      allowedDomains: allowedDomains.split(",").map((domain) => domain.trim()).filter((domain) => domain.length > 0),
      ...(email ? { email } : {}),
      ...(password ? { password } : {}),
    };

    const parsed = TargetProfileWriteInputSchema.safeParse(payload);
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      return;
    }
    setValidationError(undefined);
    onSubmit(parsed.data);
  }

  const optionalFields = [
    {
      id: "tp-loginUrl",
      label: "Login URL",
      hint: "The login page URL for this target, if it requires auto-login. Leave blank to skip login entirely for runs using this profile.",
      value: loginUrl,
      onChange: setLoginUrl,
      placeholder: "https://release.rabbit.example/#/login",
    },
    {
      id: "tp-email",
      label: "Login email",
      hint: "The login email/username value for this target. Write-only — never shown again after saving, including in Edit mode.",
      type: "email" as const,
      value: email,
      onChange: setEmail,
      placeholder: mode === "edit" ? "leave blank to keep current value" : "test@example.com",
    },
    {
      id: "tp-password",
      label: "Login password",
      hint:
        "The login password value for this target. Encrypted at rest, write-only — leave blank in " +
        "Edit mode to keep the current password unchanged.",
      type: "password" as const,
      value: password,
      onChange: setPassword,
      placeholder: mode === "edit" ? "leave blank to keep current value" : "",
    },
    {
      id: "tp-emailSelector",
      label: "Email field selector",
      hint: 'CSS selector for the login email/username input on the login page, e.g. [data-cy-id="login.email"].',
      value: emailSelector,
      onChange: setEmailSelector,
      placeholder: '[data-cy-id="login.email"]',
    },
    {
      id: "tp-passwordSelector",
      label: "Password field selector",
      hint: "CSS selector for the login password input on the login page.",
      value: passwordSelector,
      onChange: setPasswordSelector,
      placeholder: '[data-cy-id="login.password"]',
    },
    {
      id: "tp-submitSelector",
      label: "Submit button selector",
      hint: "CSS selector for the login form's submit button.",
      value: submitSelector,
      onChange: setSubmitSelector,
      placeholder: '[data-cy-id="login.button"]',
    },
    {
      id: "tp-nextSelector",
      label: '"Next" button selector (2-step login)',
      hint:
        'CSS selector for an intermediate "Next" button, only needed for 2-step logins where email and ' +
        'password are on separate screens. Leave blank for single-step logins.',
      value: nextSelector,
      onChange: setNextSelector,
      placeholder: "optional",
    },
    {
      id: "tp-timeoutMs",
      label: "Login timeout (ms)",
      hint: "Milliseconds to wait for each login step before timing out. Leave blank for the default (10000ms).",
      type: "number" as const,
      value: timeoutMs,
      onChange: setTimeoutMs,
      placeholder: "10000",
    },
    {
      id: "tp-locationsPath",
      label: "Locations path override",
      hint:
        'Overrides the default route the explorer\'s built-in "go to locations" charter step navigates to. ' +
        "Leave blank unless this target's locations flow uses a non-default route.",
      value: locationsPath,
      onChange: setLocationsPath,
      placeholder: "optional",
    },
  ];

  return (
    <form className="new-run-form target-profile-form" onSubmit={handleSubmit} noValidate>
      <h3>{mode === "create" ? "New target profile" : `Edit "${initial?.name}"`}</h3>

      <FieldLabel
        htmlFor="tp-name"
        label="Name"
        required
        hint='A display name to tell this profile apart from others, e.g. "Release" or "Dev".'
      />
      <input
        id="tp-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Release"
        required
        aria-invalid={invalidFields.has("name")}
      />
      {invalidFields.has("name") && (
        <p className="form-error" role="alert">
          {NAME_REQUIRED_MESSAGE}
        </p>
      )}

      <FieldLabel
        htmlFor="tp-baseUrl"
        label="Base URL"
        required
        hint="The base URL of the target app (scheme + host, no path)."
      />
      <input
        id="tp-baseUrl"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        placeholder="https://release.rabbit.example"
        required
        aria-invalid={invalidFields.has("baseUrl")}
      />
      {invalidFields.has("baseUrl") && (
        <p className="form-error" role="alert">
          {BASE_URL_REQUIRED_MESSAGE}
        </p>
      )}

      {optionalFields.map((field) => (
        <Fragment key={field.id}>
          <FieldLabel htmlFor={field.id} label={field.label} hint={field.hint} />
          <input
            id={field.id}
            type={field.type ?? "text"}
            value={field.value}
            onChange={(event) => field.onChange(event.target.value)}
            placeholder={field.placeholder}
          />
        </Fragment>
      ))}

      <FieldLabel
        htmlFor="tp-allowedDomains"
        label="Allowed domains"
        required
        hint={
          "Comma-separated list of hostnames a run against this profile is allowed to navigate to — " +
          "this is a real safety boundary, not just a convenience list."
        }
      />
      <input
        id="tp-allowedDomains"
        value={allowedDomains}
        onChange={(event) => setAllowedDomains(event.target.value)}
        placeholder="release.rabbit.example"
        required
        aria-invalid={invalidFields.has("allowedDomains")}
      />
      {invalidFields.has("allowedDomains") && (
        <p className="form-error" role="alert">
          {ALLOWED_DOMAINS_REQUIRED_MESSAGE}
        </p>
      )}

      <div className="target-profile-form__actions">
        <button type="submit" className="button button--primary" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : mode === "create" ? "Create profile" : "Save changes"}
        </button>
        {onCancel && (
          <button type="button" className="button button--secondary" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </button>
        )}
      </div>

      {validationError && (
        <p className="form-error" role="alert">
          {validationError}
        </p>
      )}
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
    </form>
  );
}
