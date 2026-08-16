import { findFirstNode, parseAriaSnapshot } from "@silly-rabbit/engine";
import type { Page } from "playwright";

const READINESS_POLL_INTERVAL_MS = 250;

function hasLoadingIndicator(ariaSnapshot: string): boolean {
  const tree = parseAriaSnapshot(ariaSnapshot);
  return findFirstNode(tree, (node) => node.role === "img" && /loading/i.test(node.name ?? "")) !== undefined;
}

function redact(error: unknown, secret: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replaceAll(secret, "***"));
}

export interface LoginCreds {
  loginUrl: string;
  email: string;
  password: string;
  emailSelector: string;
  passwordSelector: string;
  submitSelector: string;
  nextSelector?: string;
  timeoutMs?: number;
  loginReadyTimeoutMs?: number;
}

export async function login(page: Page, creds: LoginCreds, onBeforeNavigate?: (url: string) => Promise<void> | void): Promise<void> {
  const loginUrlObject = new URL(creds.loginUrl);
  const isOnLoginPage = (url: URL): boolean =>
    url.origin === loginUrlObject.origin && url.pathname === loginUrlObject.pathname && url.hash === loginUrlObject.hash;

  const timeout = creds.timeoutMs ?? 10_000;

  await onBeforeNavigate?.(creds.loginUrl);
  await page.goto(creds.loginUrl);

  await page.locator(creds.emailSelector).pressSequentially(creds.email);
  await page.locator(creds.emailSelector).blur();

  if (creds.nextSelector) {
    try {
      await page.locator(creds.nextSelector).click();
      await page.locator(creds.passwordSelector).waitFor({ state: "visible", timeout });
    } catch {
      throw new Error(`login failed at ${creds.loginUrl}`);
    }
  }

  try {
    await page.locator(creds.passwordSelector).fill(creds.password, { force: true, timeout });
  } catch (error) {
    const redacted = redact(error, creds.password);
    // eslint-disable-next-line preserve-caught-error -- cause must be the redacted error (raw one can leak the password)
    throw new Error(`login failed at ${creds.loginUrl}: ${redacted.message}`, { cause: redacted });
  }

  try {
    await Promise.all([page.waitForURL((url) => !isOnLoginPage(url), { timeout }), page.locator(creds.submitSelector).click()]);
  } catch (error) {
    const redacted = redact(error, creds.password);
    // eslint-disable-next-line preserve-caught-error -- cause must be the redacted error (raw one can leak the password)
    throw new Error(`login failed at ${creds.loginUrl}: ${redacted.message}`, { cause: redacted });
  }

  const readyTimeout = creds.loginReadyTimeoutMs ?? timeout;
  const readyDeadline = Date.now() + readyTimeout;
  let lastSnapshot = await page.ariaSnapshot();
  while (hasLoadingIndicator(lastSnapshot)) {
    if (Date.now() >= readyDeadline) {
      throw new Error(`post-login readiness timeout: still loading after ${readyTimeout}ms\n${lastSnapshot}`);
    }
    await page.waitForTimeout(READINESS_POLL_INTERVAL_MS);
    lastSnapshot = await page.ariaSnapshot();
  }

  if (isOnLoginPage(new URL(page.url()))) {
    throw new Error(`login failed at ${creds.loginUrl}: still on login page after readiness wait\n${lastSnapshot}`);
  }

  await onBeforeNavigate?.(page.url());
}
