export type MockVariant = "baseline" | "volatile-only" | "changed-regression";

export interface MockSeed {
  recordId: string;
  timestamp: string;
  count: number;
}

const LOCATION_HREF = "/fleet/auth/platform/locations/1";
const LOCATION_NAME = "Main Warehouse";

function page(body: string): string {
  return `<!doctype html><html><head><title>rabbit</title></head><body>${body}</body></html>`;
}

export function renderLocationsListHtml(variant: MockVariant, seed: MockSeed): string {
  const addButton = variant === "changed-regression" ? "" : `<button type="button">Add Location</button>`;

  return page(`
    <h1>Locations</h1>
    <p>Last updated: ${seed.timestamp}</p>
    <p>${seed.count} locations found</p>
    <ul>
      <li><a href="${LOCATION_HREF}">${LOCATION_NAME}</a></li>
    </ul>
    ${addButton}
  `);
}

export function renderLocationDetailHtml(seed: MockSeed): string {
  return page(`
    <h1>${LOCATION_NAME}</h1>
    <p>ID: ${seed.recordId}</p>
    <p>Last updated: ${seed.timestamp}</p>
  `);
}
