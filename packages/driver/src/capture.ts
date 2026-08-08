import type { CapturedObservation, HttpErrorSignal } from "@silly-rabbit/engine";
import { parseAriaSnapshot } from "@silly-rabbit/engine";
import type { Page } from "playwright";

export interface CaptureHandle {
  reset(): void;
  read(): { consoleErrors: string[]; httpErrors: HttpErrorSignal[] };
}

export function attachCapture(page: Page): CaptureHandle {
  let consoleErrors: string[] = [];
  let httpErrors: HttpErrorSignal[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      httpErrors.push({ method: response.request().method(), url: response.url(), status });
    }
  });

  return {
    reset() {
      consoleErrors = [];
      httpErrors = [];
    },
    read() {
      return { consoleErrors: [...consoleErrors], httpErrors: [...httpErrors] };
    },
  };
}

export async function captureObservation(page: Page, handle: CaptureHandle): Promise<CapturedObservation> {
  const ariaSnapshot = await page.ariaSnapshot({ boxes: true });
  const documentTitle = await page.title();
  const tree = parseAriaSnapshot(ariaSnapshot);
  const { consoleErrors, httpErrors } = handle.read();
  const screenshotBuffer = await page.screenshot().catch(() => undefined);

  const observation: CapturedObservation = {
    url: page.url(),
    ariaSnapshot,
    documentTitle,
    isBlank: tree.children.length === 0,
  };
  if (consoleErrors.length > 0) observation.consoleErrors = consoleErrors;
  if (httpErrors.length > 0) observation.httpErrors = httpErrors;
  if (screenshotBuffer) observation.screenshotBuffer = screenshotBuffer;

  return observation;
}
