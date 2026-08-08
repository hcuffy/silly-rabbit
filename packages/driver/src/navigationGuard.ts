import type { Page } from "playwright";

export interface NavigationGuardOptions {
  isNavigationAllowed: (url: string) => { allowed: true } | { allowed: false; reason: string };
}

export async function installNavigationGuard(page: Page, options: NavigationGuardOptions): Promise<void> {
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
      await route.fallback();
      return;
    }

    const result = options.isNavigationAllowed(request.url());
    if (result.allowed) {
      await route.fallback();
    } else {
      await route.abort("blockedbyclient");
    }
  });
}
