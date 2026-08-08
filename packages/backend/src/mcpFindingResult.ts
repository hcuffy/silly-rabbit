import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Finding } from "@silly-rabbit/shared";
import { readFile } from "node:fs/promises";

async function screenshotImageBlock(path: string | undefined): Promise<CallToolResult["content"][number] | undefined> {
  if (!path) return undefined;
  try {
    const bytes = await readFile(path);
    return { type: "image", data: bytes.toString("base64"), mimeType: "image/png" };
  } catch {
    return undefined;
  }
}

export async function findingResult(finding: Finding): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(finding) }];
  const afterImage = await screenshotImageBlock(finding.screenshotPath);
  if (afterImage) content.push(afterImage);
  const beforeImage = await screenshotImageBlock(finding.beforeScreenshotPath);
  if (beforeImage) content.push(beforeImage);
  return { content };
}
