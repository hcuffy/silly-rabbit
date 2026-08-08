import { useState, type FormEvent } from "react";
import { FieldHint } from "../components/FieldHint.js";
import { TargetProfileWriteInputSchema, type SafeTargetProfile, type TargetProfileWriteInput } from "../lib/targetProfileApiClient.js";

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

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
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

  return (
    <form className="new-run-form target-profile-form" onSubmit={handleSubmit}>
      <h3>{mode === "create" ? "New target profile" : `Edit "${initial?.name}"`}</h3>

      <div className="field-label">
        <label htmlFor="tp-name">Name</label>
        <span className="field-required" aria-hidden="true">
          *
        </span>
        <FieldHint text='A display name to tell this profile apart from others, e.g. "Release" or "Dev".' />
      </div>
      <input
        id="tp-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Release"
        required
      />

      <div className="field-label">
        <label htmlFor="tp-baseUrl">Base URL</label>
        <span className="field-required" aria-hidden="true">
          *
        </span>
        <FieldHint text="The base URL of the target app (scheme + host, no path)." />
      </div>
      <input
        id="tp-baseUrl"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        placeholder="https://release.rabbit.example"
        required
      />

      <div className="field-label">
        <label htmlFor="tp-loginUrl">Login URL</label>
        <FieldHint
          text={
            "The login page URL for this target, if it requires auto-login. Leave blank to skip login " +
            "entirely for runs using this profile."
          }
        />
      </div>
      <input
        id="tp-loginUrl"
        value={loginUrl}
        onChange={(event) => setLoginUrl(event.target.value)}
        placeholder="https://release.rabbit.example/#/login"
      />

      <div className="field-label">
        <label htmlFor="tp-email">Login email</label>
        <FieldHint text="The login email/username value for this target. Write-only — never shown again after saving, including in Edit mode." />
      </div>
      <input
        id="tp-email"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder={mode === "edit" ? "leave blank to keep current value" : "test@example.com"}
      />

      <div className="field-label">
        <label htmlFor="tp-password">Login password</label>
        <FieldHint
          text={
            "The login password value for this target. Encrypted at rest, write-only — leave blank in " +
            "Edit mode to keep the current password unchanged."
          }
        />
      </div>
      <input
        id="tp-password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder={mode === "edit" ? "leave blank to keep current value" : ""}
      />

      <div className="field-label">
        <label htmlFor="tp-emailSelector">Email field selector</label>
        <FieldHint text='CSS selector for the login email/username input on the login page, e.g. [data-cy-id="login.email"].' />
      </div>
      <input
        id="tp-emailSelector"
        value={emailSelector}
        onChange={(event) => setEmailSelector(event.target.value)}
        placeholder='[data-cy-id="login.email"]'
      />

      <div className="field-label">
        <label htmlFor="tp-passwordSelector">Password field selector</label>
        <FieldHint text="CSS selector for the login password input on the login page." />
      </div>
      <input
        id="tp-passwordSelector"
        value={passwordSelector}
        onChange={(event) => setPasswordSelector(event.target.value)}
        placeholder='[data-cy-id="login.password"]'
      />

      <div className="field-label">
        <label htmlFor="tp-submitSelector">Submit button selector</label>
        <FieldHint text="CSS selector for the login form's submit button." />
      </div>
      <input
        id="tp-submitSelector"
        value={submitSelector}
        onChange={(event) => setSubmitSelector(event.target.value)}
        placeholder='[data-cy-id="login.button"]'
      />

      <div className="field-label">
        <label htmlFor="tp-nextSelector">"Next" button selector (2-step login)</label>
        <FieldHint
          text={
            'CSS selector for an intermediate "Next" button, only needed for 2-step logins where email and ' +
            'password are on separate screens. Leave blank for single-step logins.'
          }
        />
      </div>
      <input
        id="tp-nextSelector"
        value={nextSelector}
        onChange={(event) => setNextSelector(event.target.value)}
        placeholder="optional"
      />

      <div className="field-label">
        <label htmlFor="tp-timeoutMs">Login timeout (ms)</label>
        <FieldHint text="Milliseconds to wait for each login step before timing out. Leave blank for the default (10000ms)." />
      </div>
      <input
        id="tp-timeoutMs"
        type="number"
        value={timeoutMs}
        onChange={(event) => setTimeoutMs(event.target.value)}
        placeholder="10000"
      />

      <div className="field-label">
        <label htmlFor="tp-locationsPath">Locations path override</label>
        <FieldHint
          text={
            'Overrides the default route the explorer\'s built-in "go to locations" charter step navigates to. ' +
            "Leave blank unless this target's locations flow uses a non-default route."
          }
        />
      </div>
      <input
        id="tp-locationsPath"
        value={locationsPath}
        onChange={(event) => setLocationsPath(event.target.value)}
        placeholder="optional"
      />

      <div className="field-label">
        <label htmlFor="tp-allowedDomains">Allowed domains</label>
        <span className="field-required" aria-hidden="true">
          *
        </span>
        <FieldHint
          text={
            "Comma-separated list of hostnames a run against this profile is allowed to navigate to — " +
            "this is a real safety boundary, not just a convenience list."
          }
        />
      </div>
      <input
        id="tp-allowedDomains"
        value={allowedDomains}
        onChange={(event) => setAllowedDomains(event.target.value)}
        placeholder="release.rabbit.example"
        required
      />

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
