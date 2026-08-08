import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { renderLocationDetailHtml, renderLocationsListHtml, type MockSeed, type MockVariant } from "@silly-rabbit/driver";

const port = Number(process.env.MOCK_PORT ?? 5055);
let variant: MockVariant = (process.env.MOCK_VARIANT as MockVariant | undefined) ?? "baseline";

function freshSeed(): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 7 };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);

  if (url.pathname === "/__set-variant") {
    const requested = url.searchParams.get("variant");
    if (requested === "baseline" || requested === "volatile-only" || requested === "changed-regression") {
      variant = requested;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`variant set to ${variant}`);
    } else {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("variant must be one of baseline|volatile-only|changed-regression");
    }
    return;
  }

  if (url.pathname === "/fleet/auth/platform/locations") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(renderLocationsListHtml(variant, freshSeed()));
    return;
  }

  if (/^\/fleet\/auth\/platform\/locations\/\d+$/.test(url.pathname)) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(renderLocationDetailHtml(freshSeed()));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, () => {
  console.log(`manual mock target listening on http://localhost:${port} (variant=${variant})`);
});
