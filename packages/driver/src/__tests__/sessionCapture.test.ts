import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { attachSessionCapture, type SessionCaptureHandle } from "../sessionCapture.js";

const FIXTURE_URL = "https://fixture.local/";

const FIXTURE_HTML = `<html><body>
  <button aria-label="Save">Submit</button>
  <a href="#next" aria-label="Next Page">Go</a>
  <input type="text" aria-label="Location name" />
</body></html>`;

async function gotoFixture(page: Page, html: string): Promise<void> {
  await page.route(`${FIXTURE_URL}**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(FIXTURE_URL);
}

async function waitForStepCount(capture: SessionCaptureHandle, count: number) {
  return vi.waitFor(() => {
    const steps = capture.getSteps();
    if (steps.length < count) {
      throw new Error(`expected at least ${count} step(s), have ${steps.length}`);
    }
    return steps;
  });
}

describe(
  "attachSessionCapture (session-replay-spec §4.1/§5.2, real chromium) — clicks/fills/navigations " +
    "driven programmatically, indistinguishable at the DOM-event level from a human driving the same page. " +
    "Capture is always attached before the page navigates — addInitScript only applies to documents loaded " +
    "after registration. Fixture pages load via page.route()/fulfill() + a real goto() (same pattern " +
    "sectionLocate.test.ts already uses), not page.setContent() — confirmed via audit that " +
    "page.addInitScript does not fire on page.setContent(), only on a real navigation.",
  () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser.close();
    });

    it("captures a click on a role-identifiable button", async () => {
      page = await browser.newPage();
      const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);
      await gotoFixture(page, FIXTURE_HTML);

      await page.getByRole("button", { name: "Save" }).click();

      const steps = await waitForStepCount(capture, 1);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save" });
    });

    it("captures a fill with the final value", async () => {
      page = await browser.newPage();
      const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);
      await gotoFixture(page, FIXTURE_HTML);

      await page.getByRole("textbox", { name: "Location name" }).fill("Main Warehouse");

      const steps = await waitForStepCount(capture, 1);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        action: "fill",
        selectorStrategy: "role",
        role: "textbox",
        accessibleName: "Location name",
        value: "Main Warehouse",
      });
    });

    it(
      "coalesces per-keystroke input events on the same field into one step with the final value " +
        "(real human typing fires one native `input` event per keystroke — this must not produce N steps)",
      async () => {
        page = await browser.newPage();
        const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);
        await gotoFixture(page, FIXTURE_HTML);

        await page.getByRole("textbox", { name: "Location name" }).pressSequentially("abc");

        const steps = await waitForStepCount(capture, 1);
        expect(steps).toHaveLength(1);
        expect(steps[0]).toMatchObject({ action: "fill", value: "abc" });
      },
    );

    it("does not coalesce fills across two different fields", async () => {
      page = await browser.newPage();
      const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);
      await gotoFixture(
        page,
        `<html><body>
        <input type="text" aria-label="First name" />
        <input type="text" aria-label="Last name" />
      </body></html>`,
      );

      await page.getByRole("textbox", { name: "First name" }).fill("Ada");
      await page.getByRole("textbox", { name: "Last name" }).fill("Lovelace");

      const steps = await waitForStepCount(capture, 2);
      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ accessibleName: "First name", value: "Ada" });
      expect(steps[1]).toMatchObject({ accessibleName: "Last name", value: "Lovelace" });
    });

    it(
      "never captures a real password value — redacted in-browser at the point of capture, not just " +
        "different from what was typed (audit finding #2: a real credential typed during recording was " +
        "previously persisted verbatim)",
      async () => {
        page = await browser.newPage();
        const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);
        await gotoFixture(page, `<html><body><input type="password" aria-label="Password" /></body></html>`);

        const REAL_PASSWORD = "hunter2-genuinely-real-secret";
        await page.locator('input[type="password"]').fill(REAL_PASSWORD);

        const steps = await waitForStepCount(capture, 1);
        expect(steps).toHaveLength(1);
        expect(steps[0]?.value).toBe("[REDACTED]");
        expect(steps[0]?.value).not.toBe(REAL_PASSWORD);
        expect(JSON.stringify(steps)).not.toContain(REAL_PASSWORD);
      },
    );

    it("captures a click on a role-identifiable link followed by the resulting navigation", async () => {
      page = await browser.newPage();
      const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);
      await gotoFixture(page, FIXTURE_HTML);

      await page.getByRole("link", { name: "Next Page" }).click();

      const steps = await waitForStepCount(capture, 2);
      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ action: "click", selectorStrategy: "role", role: "link", accessibleName: "Next Page" });
      expect(steps[1]?.action).toBe("navigate");
      expect(steps[1]?.value).toContain("#next");
    });

    it("falls back to a css selector when no role/accessible-name can be determined", async () => {
      page = await browser.newPage();
      const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);
      await gotoFixture(page, `<html><body><div id="unlabeled-clickable" onclick="void 0">click me</div></body></html>`);

      await page.locator("#unlabeled-clickable").click();

      const steps = await waitForStepCount(capture, 1);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ action: "click", selectorStrategy: "css", cssSelector: "#unlabeled-clickable" });
    });

    it(
      "re-attaches its listeners across a full navigation (addInitScript re-injects on every new document, " +
        "not just the first one) — the navigation between the two fixtures is itself a real, correctly " +
        "recorded step (only the recorder's own very first landing navigation is skipped, §4.1)",
      async () => {
        page = await browser.newPage();
        const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);

        await gotoFixture(page, `<html><body><button aria-label="First document">Click</button></body></html>`);
        await page.getByRole("button", { name: "First document" }).click();
        await waitForStepCount(capture, 1);

        await gotoFixture(page, `<html><body><button aria-label="Second document">Click</button></body></html>`);
        await page.getByRole("button", { name: "Second document" }).click();

        const steps = await waitForStepCount(capture, 3);
        expect(steps.map((step) => step.action)).toEqual(["click", "navigate", "click"]);
        expect(steps[0]?.accessibleName).toBe("First document");
        expect(steps[2]?.accessibleName).toBe("Second document");
      },
    );

    it("invokes onStep for every captured (or coalesced) step", async () => {
      page = await browser.newPage();
      const seen: string[] = [];
      const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin, {
        onStep: (step) => seen.push(step.action),
      });
      await gotoFixture(page, FIXTURE_HTML);

      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("textbox", { name: "Location name" }).pressSequentially("ab");

      await waitForStepCount(capture, 2);
      expect(seen).toEqual(["click", "fill", "fill"]);
      expect(capture.getSteps()).toHaveLength(2);
    });
  },
);

describe("attachSessionCapture — network capture (session-replay-spec §5.3, resolved), real chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  async function waitForCaptureCount(capture: SessionCaptureHandle, count: number) {
    return vi.waitFor(() => {
      const captures = capture.getNetworkCaptures();
      if (captures.length < count) {
        throw new Error(`expected at least ${count} capture(s), have ${captures.length}`);
      }
      return captures;
    });
  }

  it(
    "captures a same-origin fetch JSON response, but not a same-origin image fetch or a cross-origin " +
      "fetch (even JSON-shaped) — resourceType xhr/fetch + same-origin + JSON content-type, all three gates",
    async () => {
      page = await browser.newPage();
      await page.route(`${FIXTURE_URL}**`, (route) => {
        const url = route.request().url();
        if (url.endsWith("/api/data")) {
          return route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ ok: true }) });
        }
        if (url.endsWith("/image.png")) {
          return route.fulfill({ contentType: "image/png", status: 200, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
        }
        return route.fulfill({ contentType: "text/html", body: FIXTURE_HTML });
      });
      await page.route("https://cross-origin.example/**", (route) =>
        route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ leak: true }) }),
      );

      const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);
      await page.goto(FIXTURE_URL);

      await page.evaluate(async () => {
        await fetch("/api/data");
        await fetch("/image.png");
        await fetch("https://cross-origin.example/data", { mode: "no-cors" }).catch(() => undefined);
      });

      const captures = await waitForCaptureCount(capture, 1);
      expect(captures).toHaveLength(1);
      expect(captures[0]).toMatchObject({ url: `${FIXTURE_URL}api/data`, method: "GET", status: 200 });
      expect(captures[0]?.body.toString("utf8")).toBe(JSON.stringify({ ok: true }));
    },
  );

  it(
    "does not capture a non-JSON same-origin fetch response even when resourceType is fetch/xhr " +
      "(content-type gate, independent of the resourceType gate) — proven deterministically by firing the " +
      "non-JSON fetch first, then a real JSON fetch, and asserting exactly one capture lands (the JSON one), " +
      "not two, rather than a fixed sleep to assert a negative",
    async () => {
      page = await browser.newPage();
      await page.route(`${FIXTURE_URL}**`, (route) => {
        const url = route.request().url();
        if (url.endsWith("/api/text")) {
          return route.fulfill({ contentType: "text/plain", status: 200, body: "not json" });
        }
        if (url.endsWith("/api/data")) {
          return route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ ok: true }) });
        }
        return route.fulfill({ contentType: "text/html", body: FIXTURE_HTML });
      });

      const capture = await attachSessionCapture(page, new Date(), new URL(FIXTURE_URL).origin);
      await page.goto(FIXTURE_URL);

      await page.evaluate(async () => {
        await fetch("/api/text");
        await fetch("/api/data");
      });

      const captures = await waitForCaptureCount(capture, 1);
      expect(captures).toHaveLength(1);
      expect(captures[0]?.url).toBe(`${FIXTURE_URL}api/data`);
    },
  );
});
