import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, type LoginCreds } from "../login.js";

const LOGIN_URL = "http://mock.local/login";

const TEST_CREDS: LoginCreds = {
  loginUrl: LOGIN_URL,
  email: "test@example.com",
  password: "mock-password-not-real",
  emailSelector: '[data-cy-id="email"]',
  passwordSelector: '[data-cy-id="password"]',
  submitSelector: '[data-cy-id="submit"]',
  timeoutMs: 2000,
};

function slowSpinnerLoginHtml(spinnerMs: number): string {
  return `<!doctype html><html><body>
    <input data-cy-id="email" type="email"
      onblur="document.querySelector('[data-cy-id=password]').style.removeProperty('display')" />
    <input data-cy-id="password" type="password" style="display:none" />
    <button data-cy-id="submit" type="button" onclick="
      window.location.hash = '/dashboard';
      document.body.innerHTML = '<img alt=\\'Loading\\' src=\\'x\\' />';
      setTimeout(function() {
        document.body.innerHTML = '<h1>Dashboard</h1>';
      }, ${spinnerMs});
    ">Login</button>
  </body></html>`;
}

function stuckSpinnerLoginHtml(): string {
  return `<!doctype html><html><body>
    <input data-cy-id="email" type="email"
      onblur="document.querySelector('[data-cy-id=password]').style.removeProperty('display')" />
    <input data-cy-id="password" type="password" style="display:none" />
    <button data-cy-id="submit" type="button" onclick="
      window.location.hash = '/dashboard';
      document.body.innerHTML = '<img alt=\\'Loading\\' src=\\'x\\' />';
    ">Login</button>
  </body></html>`;
}

function bounceBackToLoginHtml(): string {
  return `<!doctype html><html><body>
    <input data-cy-id="email" type="email"
      onblur="document.querySelector('[data-cy-id=password]').style.removeProperty('display')" />
    <input data-cy-id="password" type="password" style="display:none" />
    <button data-cy-id="submit" type="button" onclick="
      window.location.hash = '/dashboard';
      document.body.innerHTML = '<img alt=\\'Loading\\' src=\\'x\\' />';
      setTimeout(function() {
        document.body.innerHTML = '';
        window.location.hash = '/login';
      }, 100);
    ">Login</button>
  </body></html>`;
}

describe("login post-login readiness wait (bug #3, auto-login-spec §2/§6)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  async function withContext(runTest: (context: BrowserContext) => Promise<void>): Promise<void> {
    const context = await browser.newContext();
    try {
      await runTest(context);
    } finally {
      await context.close();
    }
  }

  it("waits past a slow post-login spinner before resolving", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) => route.fulfill({ contentType: "text/html", body: slowSpinnerLoginHtml(300) }));
      const page = await context.newPage();
      const hashLoginUrl = `${LOGIN_URL}#/login`;
      await login(page, {
        ...TEST_CREDS,
        loginUrl: hashLoginUrl,
        timeoutMs: 3000,
        loginReadyTimeoutMs: 3000,
      });
      expect(page.url()).toContain("#/dashboard");
      const snapshot = await page.ariaSnapshot();
      expect(snapshot).toContain("Dashboard");
    });
  });

  it("throws a clear readiness-timeout error, with the final snapshot, when the spinner never clears", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) => route.fulfill({ contentType: "text/html", body: stuckSpinnerLoginHtml() }));
      const page = await context.newPage();
      const hashLoginUrl = `${LOGIN_URL}#/login`;
      let caught: unknown;
      try {
        await login(page, {
          ...TEST_CREDS,
          loginUrl: hashLoginUrl,
          timeoutMs: 3000,
          loginReadyTimeoutMs: 500,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("post-login readiness timeout: still loading after 500ms");
      expect((caught as Error).message).toContain("Loading");
      expect((caught as Error).message).not.toContain(TEST_CREDS.password);
    });
  });

  it("fails when the spinner clears but the app bounced back to the login route", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) => route.fulfill({ contentType: "text/html", body: bounceBackToLoginHtml() }));
      const page = await context.newPage();
      const hashLoginUrl = `${LOGIN_URL}#/login`;
      let caught: unknown;
      try {
        await login(page, {
          ...TEST_CREDS,
          loginUrl: hashLoginUrl,
          timeoutMs: 3000,
          loginReadyTimeoutMs: 3000,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("still on login page after readiness wait");
      expect((caught as Error).message).not.toContain(TEST_CREDS.password);
    });
  });
});
