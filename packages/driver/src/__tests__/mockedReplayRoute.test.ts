import type { NetworkCapture } from "@silly-rabbit/shared";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMockedReplayRoute } from "../mockedReplayRoute.js";

const FIXTURE_URL = "https://mocked-replay.local/";

describe("installMockedReplayRoute (session-replay-spec §4.3/§5.3), real chromium", () => {
  let browser: Browser;
  let page: Page;
  let bodyDirectory: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    bodyDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mocked-replay-"));
  });

  afterAll(async () => {
    await browser.close();
  });

  afterEach(async () => {
    await page.close();
  });

  async function writeCaptureBody(name: string, content: unknown): Promise<string> {
    const path = join(bodyDirectory, name);
    await writeFile(path, JSON.stringify(content));
    return path;
  }

  it("fulfills a matching xhr/fetch request from the recorded response, never reaching the live handler", async () => {
    page = await browser.newPage();
    let liveApiHits = 0;
    await page.route(`${FIXTURE_URL}**`, (route) => {
      const url = route.request().url();
      if (url.endsWith("/api/data")) {
        liveApiHits++;
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ live: true }) });
      }
      return route.fulfill({ contentType: "text/html", body: "<html><body>ok</body></html>" });
    });

    const bodyPath = await writeCaptureBody("data.json", { recorded: true });
    const networkCaptures: NetworkCapture[] = [{ url: `${FIXTURE_URL}api/data`, method: "GET", status: 200, bodyPath, timestampOffsetMs: 0 }];
    await installMockedReplayRoute(page, networkCaptures);

    await page.goto(FIXTURE_URL);
    const result = await page.evaluate(
      async (): Promise<{ recorded: boolean }> => (await (await fetch("/api/data")).json()) as { recorded: boolean },
    );

    expect(result).toEqual({ recorded: true });
    expect(liveApiHits).toBe(0);
  });

  it(
    "a request with the same method+url matched twice consumes the queue in order (FIFO), not the same " +
      "response repeated — e.g. a recorded poll returning two different bodies in sequence",
    async () => {
      page = await browser.newPage();
      await page.route(`${FIXTURE_URL}**`, (route) => route.fulfill({ contentType: "text/html", body: "<html><body>ok</body></html>" }));

      const firstBodyPath = await writeCaptureBody("poll-1.json", { count: 1 });
      const secondBodyPath = await writeCaptureBody("poll-2.json", { count: 2 });
      const networkCaptures: NetworkCapture[] = [
        { url: `${FIXTURE_URL}api/poll`, method: "GET", status: 200, bodyPath: firstBodyPath, timestampOffsetMs: 0 },
        { url: `${FIXTURE_URL}api/poll`, method: "GET", status: 200, bodyPath: secondBodyPath, timestampOffsetMs: 100 },
      ];
      await installMockedReplayRoute(page, networkCaptures);
      await page.goto(FIXTURE_URL);

      const results = await page.evaluate(
        async (): Promise<{ count: number }[]> => [
          (await (await fetch("/api/poll")).json()) as { count: number },
          (await (await fetch("/api/poll")).json()) as { count: number },
        ],
      );

      expect(results).toEqual([{ count: 1 }, { count: 2 }]);
    },
  );

  it(
    "a 3rd request against a 2-entry queue for the same method+url fails closed, same as an entirely " +
      "unmatched request — explicit, not just inferred from the unmatched-request case being the same code " +
      "path (audit coverage gap: queue exhaustion was previously untested)",
    async () => {
      page = await browser.newPage();
      await page.route(`${FIXTURE_URL}**`, (route) => route.fulfill({ contentType: "text/html", body: "<html><body>ok</body></html>" }));

      const firstBodyPath = await writeCaptureBody("poll-1.json", { count: 1 });
      const secondBodyPath = await writeCaptureBody("poll-2.json", { count: 2 });
      const networkCaptures: NetworkCapture[] = [
        { url: `${FIXTURE_URL}api/poll`, method: "GET", status: 200, bodyPath: firstBodyPath, timestampOffsetMs: 0 },
        { url: `${FIXTURE_URL}api/poll`, method: "GET", status: 200, bodyPath: secondBodyPath, timestampOffsetMs: 100 },
      ];
      await installMockedReplayRoute(page, networkCaptures);
      await page.goto(FIXTURE_URL);

      const outcomes = await page.evaluate(async (): Promise<boolean[]> => {
        const attempt = async (): Promise<boolean> => {
          try {
            await fetch("/api/poll");
            return true;
          } catch {
            return false;
          }
        };
        return [await attempt(), await attempt(), await attempt()];
      });

      expect(outcomes).toEqual([true, true, false]);
    },
  );

  it("aborts an xhr/fetch request with no matching recorded response — fails closed, never falls through live", async () => {
    page = await browser.newPage();
    let liveApiHits = 0;
    await page.route(`${FIXTURE_URL}**`, (route) => {
      const url = route.request().url();
      if (url.endsWith("/api/unrecorded")) {
        liveApiHits++;
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ live: true }) });
      }
      return route.fulfill({ contentType: "text/html", body: "<html><body>ok</body></html>" });
    });

    await installMockedReplayRoute(page, []);
    await page.goto(FIXTURE_URL);

    const failed = await page.evaluate(async () => {
      try {
        await fetch("/api/unrecorded");
        return false;
      } catch {
        return true;
      }
    });

    expect(failed).toBe(true);
    expect(liveApiHits).toBe(0);
  });

  it(
    "still lets document requests hit the live handler unmodified — mocked mode only covers same-origin " + "xhr/fetch, not the page shell itself",
    async () => {
      page = await browser.newPage();
      let documentHits = 0;
      await page.route(`${FIXTURE_URL}**`, (route) => {
        documentHits++;
        return route.fulfill({ contentType: "text/html", body: "<html><body><h1>live document</h1></body></html>" });
      });

      await installMockedReplayRoute(page, []);
      await page.goto(FIXTURE_URL);

      expect(documentHits).toBeGreaterThan(0);
      expect(await page.locator("h1").textContent()).toBe("live document");
    },
  );

  it(
    "navigation requests are not swallowed by the mocked route — a second goto still reaches the live " +
      "handler, proving mocked mode defers navigation via fallback rather than intercepting it itself",
    async () => {
      page = await browser.newPage();
      let hits = 0;
      await page.route(`${FIXTURE_URL}**`, (route) => {
        hits++;
        return route.fulfill({ contentType: "text/html", body: "<html><body>ok</body></html>" });
      });
      await installMockedReplayRoute(page, []);

      await page.goto(FIXTURE_URL);
      await page.goto(`${FIXTURE_URL}second`);

      expect(hits).toBe(2);
    },
  );
});
