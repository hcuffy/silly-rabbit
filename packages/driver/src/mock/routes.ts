import type { BrowserContext } from "playwright";
import { renderLocationDetailHtml, renderLocationsListHtml, type MockSeed, type MockVariant } from "./pages.js";

const LIST_PATH = "/fleet/auth/platform/locations";
const DETAIL_PATH = /^\/fleet\/auth\/platform\/locations\/\d+$/;

export async function installMockTarget(
  context: BrowserContext,
  variant: MockVariant,
  seed: MockSeed,
): Promise<void> {
  await context.route(`**${LIST_PATH}**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    if (pathname === LIST_PATH) {
      await route.fulfill({ contentType: "text/html", body: renderLocationsListHtml(variant, seed) });
      return;
    }

    if (DETAIL_PATH.test(pathname)) {
      await route.fulfill({ contentType: "text/html", body: renderLocationDetailHtml(seed) });
      return;
    }

    await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
  });
}
