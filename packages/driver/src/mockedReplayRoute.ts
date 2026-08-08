import type { NetworkCapture } from "@silly-rabbit/shared";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";

const MOCKED_RESOURCE_TYPES = new Set(["xhr", "fetch"]);

interface QueuedResponse {
  status: number;
  body: Buffer;
}

function captureKey(method: string, url: string): string {
  return `${method} ${url}`;
}

async function buildResponseQueues(networkCaptures: NetworkCapture[]): Promise<Map<string, QueuedResponse[]>> {
  const queuesByKey = new Map<string, QueuedResponse[]>();
  for (const capture of networkCaptures) {
    const body = await readFile(capture.bodyPath);
    const key = captureKey(capture.method, capture.url);
    const queue = queuesByKey.get(key) ?? [];
    queue.push({ status: capture.status, body });
    queuesByKey.set(key, queue);
  }
  return queuesByKey;
}

// Audit note (finding #5, not fixed — unreachable today, no code path opens a new page): this only
// intercepts `page`'s own requests. If a step ever opens a popup/new tab, or the target app routes a
// request through a Service Worker, that traffic would bypass this route entirely and hit the real
// backend, even in "mocked" mode. Revisit if popup/new-page handling is ever added to replay.
export async function installMockedReplayRoute(page: Page, networkCaptures: NetworkCapture[]): Promise<void> {
  const queuesByKey = await buildResponseQueues(networkCaptures);

  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.isNavigationRequest()) {
      await route.fallback();
      return;
    }
    if (!MOCKED_RESOURCE_TYPES.has(request.resourceType())) {
      await route.fallback();
      return;
    }

    const queue = queuesByKey.get(captureKey(request.method(), request.url()));
    const next = queue?.shift();
    if (!next) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ status: next.status, contentType: "application/json", body: next.body });
  });
}
