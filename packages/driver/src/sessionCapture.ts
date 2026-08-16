import type { SessionRecordingStep } from "@silly-rabbit/shared";
import type { Page } from "playwright";

export interface RawNetworkCapture {
  url: string;
  method: string;
  status: number;
  body: Buffer;
  timestampOffsetMs: number;
}

export interface SessionCaptureHandle {
  getSteps(): SessionRecordingStep[];
  getNetworkCaptures(): RawNetworkCapture[];
}

export interface SessionCaptureOptions {
  onStep?: (step: SessionRecordingStep) => void;
}

const CAPTURED_RESOURCE_TYPES = new Set(["xhr", "fetch"]);

function isJsonResponse(contentType: string | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("json");
}

interface RawCapturedEvent {
  action: "click" | "fill";
  selectorStrategy: "role" | "css";
  role?: string;
  accessibleName?: string;
  cssSelector?: string;
  value?: string;
}

const CAPTURE_BINDING_NAME = "__sillyRabbitRecordStep";

function isSameTarget(a: Omit<SessionRecordingStep, "timestampOffsetMs">, b: SessionRecordingStep): boolean {
  if (a.selectorStrategy !== b.selectorStrategy) {
    return false;
  }
  return a.selectorStrategy === "role" ? a.role === b.role && a.accessibleName === b.accessibleName : a.cssSelector === b.cssSelector;
}

// eslint-disable-next-line max-params -- named options param, not a raw scalar
export async function attachSessionCapture(
  page: Page,
  recordingStartedAt: Date,
  targetOrigin: string,
  options: SessionCaptureOptions = {},
): Promise<SessionCaptureHandle> {
  const steps: SessionRecordingStep[] = [];
  const networkCaptures: RawNetworkCapture[] = [];

  page.on("response", (response) => {
    void (async () => {
      const request = response.request();
      if (!CAPTURED_RESOURCE_TYPES.has(request.resourceType())) {
        return;
      }
      if (new URL(response.url()).origin !== targetOrigin) {
        return;
      }
      if (!isJsonResponse(response.headers()["content-type"])) {
        return;
      }

      const body = await response.body().catch(() => undefined);
      if (!body) {
        return;
      }

      networkCaptures.push({
        url: response.url(),
        method: request.method(),
        status: response.status(),
        body,
        timestampOffsetMs: Date.now() - recordingStartedAt.getTime(),
      });
    })();
  });

  const recordStep = (partial: Omit<SessionRecordingStep, "timestampOffsetMs">): void => {
    const timestampOffsetMs = Date.now() - recordingStartedAt.getTime();
    const lastStep = steps.at(-1);
    if (partial.action === "fill" && lastStep?.action === "fill" && isSameTarget(partial, lastStep)) {
      lastStep.value = partial.value;
      lastStep.timestampOffsetMs = timestampOffsetMs;
      options.onStep?.(lastStep);
      return;
    }
    const step: SessionRecordingStep = { ...partial, timestampOffsetMs };
    steps.push(step);
    options.onStep?.(step);
  };

  await page.exposeFunction(CAPTURE_BINDING_NAME, (event: RawCapturedEvent) => recordStep(event));
  await page.addInitScript(installPageListeners, CAPTURE_BINDING_NAME);

  let hasSkippedInitialNavigation = false;
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }
    if (!hasSkippedInitialNavigation) {
      hasSkippedInitialNavigation = true;
      return;
    }
    recordStep({ action: "navigate", selectorStrategy: "css", value: frame.url() });
  });

  return { getSteps: () => steps, getNetworkCaptures: () => networkCaptures };
}

/**
 * Runs inside the page (via addInitScript, re-injected on every navigation) — public Playwright
 * primitives only (exposeFunction/addInitScript), not codegen's internal recorder (session-replay-spec
 * §4.1: no exported API for that exists in the installed playwright-core, confirmed via audit).
 *
 * Written with `const` arrow-function bindings throughout, not function declarations — a named function
 * declaration here gets esbuild's `__name(fn, "name")` name-preservation wrapper under tsx/vitest's dev
 * transform, and that helper doesn't exist once this function's source is torn out by `.toString()` and
 * re-injected into the page in isolation (confirmed via a real `page.on("pageerror")` repro: "__name is
 * not defined", silently breaking every listener inside — arrow bindings don't trigger the wrapper).
 */
const installPageListeners = (bindingName: string): void => {
  const IMPLICIT_ROLE_BY_TAG: Record<string, string> = {
    BUTTON: "button",
    TEXTAREA: "textbox",
    SELECT: "combobox",
  };

  const inferRole = (element: Element): string | undefined => {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    if (element.tagName === "A" && element.hasAttribute("href")) {
      return "link";
    }
    if (element.tagName === "INPUT") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") {
        return "checkbox";
      }
      if (type === "radio") {
        return "radio";
      }
      return "textbox";
    }
    return IMPLICIT_ROLE_BY_TAG[element.tagName];
  };

  const accessibleNameFor = (element: Element): string => {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return ariaLabel.trim();
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelElement = document.getElementById(labelledBy);
      if (labelElement?.textContent) {
        return labelElement.textContent.trim();
      }
    }
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) {
      return placeholder.trim();
    }
    return element.textContent?.trim() ?? "";
  };

  const cssSelectorFor = (element: Element): string => {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }
    const parts: string[] = [];
    let current: Element | null = element;
    for (let depth = 0; current && depth < 4; depth++) {
      const tagName = current.tagName;
      let part = tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };

  const describeSelector = (
    element: Element,
  ): { selectorStrategy: "role"; role: string; accessibleName: string } | { selectorStrategy: "css"; cssSelector: string } => {
    const role = inferRole(element);
    const accessibleName = role ? accessibleNameFor(element) : "";
    if (role && accessibleName) {
      return { selectorStrategy: "role", role, accessibleName };
    }
    return { selectorStrategy: "css", cssSelector: cssSelectorFor(element) };
  };

  const report = (window as unknown as Record<string, (event: unknown) => void>)[bindingName];
  if (!report) {
    return;
  }

  document.addEventListener(
    "click",
    (domEvent) => {
      if (!(domEvent.target instanceof Element)) {
        return;
      }
      report({ action: "click", ...describeSelector(domEvent.target) });
    },
    true,
  );

  document.addEventListener(
    "input",
    (domEvent) => {
      const target = domEvent.target;
      if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) {
        return;
      }
      // Never capture a real password value — redacted at the point of capture, in-browser, not after
      // (a recorded session may be against a real login form with a real credential).
      const isPassword = target instanceof HTMLInputElement && target.type === "password";
      report({ action: "fill", ...describeSelector(target), value: isPassword ? "[REDACTED]" : target.value });
    },
    true,
  );
};
