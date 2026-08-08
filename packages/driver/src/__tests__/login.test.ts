import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, type LoginCreds } from "../login.js";

const LOGIN_URL = "http://mock.local/login";
const SUCCESS_URL = "http://mock.local/dashboard";

const TEST_CREDS: LoginCreds = {
  loginUrl: LOGIN_URL,
  email: "test@example.com",
  password: "mock-password-not-real",
  emailSelector: '[data-cy-id="email"]',
  passwordSelector: '[data-cy-id="password"]',
  submitSelector: '[data-cy-id="submit"]',
  timeoutMs: 2000,
};

function successLoginHtml(): string {
  return `<!doctype html><html><body>
    <input data-cy-id="email" type="email"
      onblur="document.querySelector('[data-cy-id=password]').style.removeProperty('display')" />
    <input data-cy-id="password" type="password" style="display:none" />
    <button data-cy-id="submit" type="button"
      onclick="window.location.href='${SUCCESS_URL}'">Login</button>
  </body></html>`;
}

function failureLoginHtml(): string {
  return `<!doctype html><html><body>
    <input data-cy-id="email" type="email" />
    <input data-cy-id="password" type="password" style="display:none" />
    <button data-cy-id="submit" type="button">Login</button>
  </body></html>`;
}

function fillFailureLoginHtml(): string {
  return `<!doctype html><html><body>
    <input data-cy-id="email" type="email" />
    <!-- no [data-cy-id="password"] — fill will throw -->
    <button data-cy-id="submit" type="button">Login</button>
  </body></html>`;
}

function twoStepLoginHtml(): string {
  return `<!doctype html><html><body>
    <input data-cy-id="email" type="email" />
    <button data-cy-id="next" type="button"
      onclick="document.querySelector('[data-cy-id=password]').style.removeProperty('display')">Next</button>
    <input data-cy-id="password" type="password" style="display:none" />
    <button data-cy-id="submit" type="button"
      onclick="window.location.href='${SUCCESS_URL}'">Login</button>
  </body></html>`;
}

function emberSwapLoginHtml(): string {
  return `<!doctype html><html><body>
    <input data-cy-id="email" type="email" />
    <button data-cy-id="next" type="button" onclick="
      var old = document.querySelector('[data-cy-id=password]');
      setTimeout(function() {
        old.remove();
        var el = document.createElement('input');
        el.type = 'password';
        el.setAttribute('data-cy-id', 'password');
        document.body.appendChild(el);
      }, 200);
    ">Next</button>
    <input data-cy-id="password" type="password" style="display:none" />
    <button data-cy-id="submit" type="button" onclick="
      var pw = document.querySelector('[data-cy-id=password]');
      if (pw && pw.value === '${TEST_CREDS.password}') {
        window.location.href='${SUCCESS_URL}';
      }
    ">Login</button>
  </body></html>`;
}

function hashRoutingLoginHtml(): string {
  return `<!doctype html><html><body>
    <input data-cy-id="email" type="email"
      onblur="document.querySelector('[data-cy-id=password]').style.removeProperty('display')" />
    <input data-cy-id="password" type="password" style="display:none" />
    <button data-cy-id="submit" type="button"
      onclick="window.location.hash = '/dashboard'">Login</button>
  </body></html>`;
}

describe("login (auto-login-spec §2/§6)", () => {
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

  it("resolves when login navigates away from the login URL", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) =>
        route.fulfill({ contentType: "text/html", body: successLoginHtml() }),
      );
      await context.route(`${SUCCESS_URL}**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body><h1>Dashboard</h1></body></html>",
        }),
      );
      const page = await context.newPage();
      await login(page, TEST_CREDS);
      expect(page.url()).toContain("dashboard");
    });
  });

  it("resolves the 2-step (identifier-first) flow when nextSelector is set", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) =>
        route.fulfill({ contentType: "text/html", body: twoStepLoginHtml() }),
      );
      await context.route(`${SUCCESS_URL}**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body><h1>Dashboard</h1></body></html>",
        }),
      );
      const page = await context.newPage();
      await login(page, { ...TEST_CREDS, nextSelector: '[data-cy-id="next"]' });
      expect(page.url()).toContain("dashboard");
    });
  });

  it("throws a credential-free error when login page does not navigate away", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) =>
        route.fulfill({ contentType: "text/html", body: failureLoginHtml() }),
      );
      const page = await context.newPage();
      let caught: unknown;
      try {
        await login(page, TEST_CREDS);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(`login failed at ${LOGIN_URL}`);
      expect((caught as Error).message).not.toContain(TEST_CREDS.password);
    });
  });

  it("checks loginUrl against onBeforeNavigate before any navigation (safety-spec §3)", async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      const guardError = new Error(`host "mock.local" is not on the domain allowlist`);
      let caught: unknown;
      try {
        await login(page, TEST_CREDS, (url) => {
          if (url === LOGIN_URL) throw guardError;
        });
      } catch (error) {
        caught = error;
      }
  
      expect(caught).toBe(guardError);
      expect(page.url()).toBe("about:blank");
    });
  });

  it("re-checks the post-login redirect URL against onBeforeNavigate", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) =>
        route.fulfill({ contentType: "text/html", body: successLoginHtml() }),
      );
      await context.route(`${SUCCESS_URL}**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body><h1>Dashboard</h1></body></html>",
        }),
      );
      const page = await context.newPage();
      const guardError = new Error(`host "mock.local" matches a production-url pattern`);
      let caught: unknown;
      try {
        await login(page, TEST_CREDS, (url) => {
          if (url.includes("dashboard")) throw guardError;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(guardError);
      expect((caught as Error).message).not.toContain(TEST_CREDS.password);
    });
  });

  it("succeeds unchanged when the hook passes every URL", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) =>
        route.fulfill({ contentType: "text/html", body: successLoginHtml() }),
      );
      await context.route(`${SUCCESS_URL}**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body><h1>Dashboard</h1></body></html>",
        }),
      );
      const page = await context.newPage();
      const seen: string[] = [];
      await login(page, TEST_CREDS, (url) => {
        seen.push(url);
      });
      expect(page.url()).toContain("dashboard");
      expect(seen[0]).toBe(LOGIN_URL);
      expect(seen[seen.length - 1]).toContain("dashboard");
    });
  });

  it("waits for the password element to reveal after nextSelector when the app destroys and recreates it (Ember-swap regression)", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) =>
        route.fulfill({ contentType: "text/html", body: emberSwapLoginHtml() }),
      );
      await context.route(`${SUCCESS_URL}**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body><h1>Dashboard</h1></body></html>",
        }),
      );
      const page = await context.newPage();
      await login(page, { ...TEST_CREDS, nextSelector: '[data-cy-id="next"]' });
      expect(page.url()).toContain("dashboard");
    });
  });

  it("resolves when the app navigates via a hash-only change (hash-routing regression)", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) =>
        route.fulfill({ contentType: "text/html", body: hashRoutingLoginHtml() }),
      );
      const page = await context.newPage();
      const hashLoginUrl = `${LOGIN_URL}#/login`;
      await login(page, { ...TEST_CREDS, loginUrl: hashLoginUrl, timeoutMs: 3000 });
      expect(page.url()).toContain("#/dashboard");
    });
  });

  it("redacts password from Playwright fill error (call-log sanitization)", async () => {
    await withContext(async (context) => {
      await context.route(`${LOGIN_URL}**`, (route) =>
        route.fulfill({ contentType: "text/html", body: fillFailureLoginHtml() }),
      );
      const page = await context.newPage();
      let caught: unknown;
      try {
        await login(page, { ...TEST_CREDS, timeoutMs: 1000 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(TEST_CREDS.password);
      expect((caught as Error).message).toContain("login failed at");
    });
  });
});
