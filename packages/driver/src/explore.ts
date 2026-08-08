import { findFirstNode, parseAriaSnapshot, type CapturedObservation } from "@silly-rabbit/engine";
import type { Browser, BrowserContext } from "playwright";
import { attachCapture, captureObservation } from "./capture.js";
import { resolveCharter, type CharterNavConfig } from "./charter.js";
import { login, type LoginCreds } from "./login.js";
import { installNavigationGuard, type NavigationGuardOptions } from "./navigationGuard.js";

export interface ActionDescriptor {
  role: string;
  accessibleName: string;
}

export interface ExploreOptions {
  charter: string;
  baseUrl: string;
  browser: Browser;
  loginCreds?: LoginCreds;
  storageState?: string;
  installRoutes?: (context: BrowserContext) => Promise<void>;
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
  isNavigationAllowed?: NavigationGuardOptions["isNavigationAllowed"];
  maxSteps?: number;
  charterNav?: CharterNavConfig;
}

export async function explore(options: ExploreOptions): Promise<CapturedObservation[]> {
  const plan = resolveCharter(options.charter, options.charterNav);
  const steps = options.maxSteps !== undefined ? plan.steps.slice(0, options.maxSteps) : plan.steps;
  const useStorageState = options.loginCreds === undefined && options.storageState !== undefined;
  const context = await options.browser.newContext(
    useStorageState ? { storageState: options.storageState } : {},
  );

  try {
    if (options.installRoutes) await options.installRoutes(context);

    const page = await context.newPage();
    if (options.isNavigationAllowed) {
      await installNavigationGuard(page, { isNavigationAllowed: options.isNavigationAllowed });
    }
    const handle = attachCapture(page);

    if (options.loginCreds) {
      await login(page, options.loginCreds, options.onBeforeNavigate);
    }

    const observations: CapturedObservation[] = [];

    for (const step of steps) {
      handle.reset();
      if (step.kind === "navigate") {
        const url = `${options.baseUrl}${step.path}`;
        await options.onBeforeNavigate?.(url);
        await page.goto(url);
      } else {
        const snapshot = await page.ariaSnapshot();
        const tree = parseAriaSnapshot(snapshot);
        const firstLink = findFirstNode(tree, (node) => node.role === "link");
        const accessibleName = firstLink?.name ?? "";
        await options.onBeforeAction?.({ role: "link", accessibleName });

        const link = page.getByRole("link").first();
        const href = await link.getAttribute("href");
        if (href) {
          const resolvedUrl = new URL(href, page.url()).toString();
          await options.onBeforeNavigate?.(resolvedUrl);
        }
        await link.click();
      }
      await page.waitForLoadState("networkidle");
      observations.push(await captureObservation(page, handle));
    }

    return observations;
  } finally {
    await context.close();
  }
}
