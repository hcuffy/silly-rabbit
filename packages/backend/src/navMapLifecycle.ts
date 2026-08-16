import { installNavigationGuard, login, type LoginCreds } from "@silly-rabbit/driver";
import { crawlNavMap } from "@silly-rabbit/explorer";
import { NavMapSchema, type NavMap } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext } from "playwright";
import { reserveRunSlot } from "./orchestrator.js";
import type { NavMapRepo } from "./repos/navMapRepo.js";
import {
  assertAllowedUrl,
  assertNotDestructive,
  assertNotProductionUrl,
  buildNavigationAllowedCheck,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  type ActionDescriptor,
} from "./safety.js";

export interface NavMapLifecycleDeps {
  navMapRepo: NavMapRepo;
  allowedDomains: string[];
  productionUrlPatterns: RegExp[];
  loginCreds?: LoginCreds;
  installRoutes?: (context: BrowserContext) => Promise<void>;
  maxConcurrentRuns?: number;
  maxNavMapEntries?: number;
  destructivePatterns?: string[];
}

export interface BuildNavMapInput {
  baseUrl: string;
}

async function executeNavMapCrawl(input: BuildNavMapInput, deps: NavMapLifecycleDeps): Promise<NavMap> {
  const { baseUrl } = input;
  assertAllowedUrl(baseUrl, deps.allowedDomains);
  assertNotProductionUrl(baseUrl, deps.productionUrlPatterns);
  if (deps.loginCreds) {
    assertAllowedUrl(deps.loginCreds.loginUrl, deps.allowedDomains);
    assertNotProductionUrl(deps.loginCreds.loginUrl, deps.productionUrlPatterns);
  }

  const startedAt = Date.now();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    if (deps.installRoutes) {
      await deps.installRoutes(context);
    }

    const page = await context.newPage();
    await installNavigationGuard(page, {
      isNavigationAllowed: buildNavigationAllowedCheck(deps.allowedDomains, deps.productionUrlPatterns),
    });

    const onBeforeNavigate = (url: string): void => {
      assertAllowedUrl(url, deps.allowedDomains);
      assertNotProductionUrl(url, deps.productionUrlPatterns);
    };
    const destructivePatterns = deps.destructivePatterns ?? DEFAULT_DESTRUCTIVE_PATTERNS;
    const onBeforeAction = (action: ActionDescriptor): void => assertNotDestructive(action, destructivePatterns);

    if (deps.loginCreds) {
      await login(page, deps.loginCreds, onBeforeNavigate);
    } else {
      onBeforeNavigate(baseUrl);
      await page.goto(baseUrl);
    }

    const entries = await crawlNavMap(page, { onBeforeNavigate, onBeforeAction, maxEntries: deps.maxNavMapEntries });

    const existing = await deps.navMapRepo.getByBaseUrl(baseUrl);
    const navMap = NavMapSchema.parse({
      id: existing?.id ?? randomUUID(),
      baseUrl,
      entries,
      crawledAt: new Date(),
      crawlDurationMs: Date.now() - startedAt,
    });
    await deps.navMapRepo.upsert(navMap);
    return navMap;
  } finally {
    await browser.close();
  }
}

export async function buildNavMap(input: BuildNavMapInput, deps: NavMapLifecycleDeps): Promise<NavMap> {
  const releaseSlot = reserveRunSlot(deps.maxConcurrentRuns);
  try {
    return await executeNavMapCrawl(input, deps);
  } finally {
    releaseSlot();
  }
}
