import type { ActionDescriptor } from "@silly-rabbit/driver";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rollback } from "../rollback.js";

const TABLE_PAGE = `
  <html><body>
    <h1>Locations</h1>
    <table>
      <tr><th>Name</th><th>Region</th><th>Actions</th></tr>
      <tr>
        <td>silly-rabbit-test-a1b2c3d4 Acme HQ</td>
        <td>West</td>
        <td><button type="button" onclick="this.closest('tr').remove()">Delete</button></td>
      </tr>
      <tr>
        <td>Existing Warehouse</td>
        <td>East</td>
        <td><button type="button" onclick="this.closest('tr').remove()">Delete</button></td>
      </tr>
    </table>
  </body></html>
`;

describe("rollback (explorer-spec §8.6/§8.7, real chromium)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("zero candidates → FAILED 'row not found'", async () => {
    await page.setContent(TABLE_PAGE);
    const result = await rollback(page, { kind: "marker", marker: "silly-rabbit-test-doesnotexist" });
    expect(result).toEqual({ status: "FAILED", reason: "row not found" });
  });

  it("more than one candidate → FAILED 'ambiguous match', never deletes on a guess", async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <table>
          <tr><th>Name</th><th>Actions</th></tr>
          <tr><td>silly-rabbit-test-dupe Row One</td><td><button type="button">Delete</button></td></tr>
          <tr><td>silly-rabbit-test-dupe Row Two</td><td><button type="button">Delete</button></td></tr>
        </table>
      </body></html>
    `);
    const result = await rollback(page, { kind: "marker", marker: "silly-rabbit-test-dupe" });
    expect(result).toEqual({ status: "FAILED", reason: "ambiguous match" });
    expect(await page.getByRole("row").count()).toBe(3);
  });

  it("exactly one candidate: clicks delete, verifies gone, returns OK — marker locator", async () => {
    await page.setContent(TABLE_PAGE);
    const result = await rollback(page, { kind: "marker", marker: "silly-rabbit-test-a1b2c3d4" });
    expect(result).toEqual({ status: "OK" });
    expect(await (page.getByText("Acme HQ")).count()).toBe(0);
    expect(await (page.getByText("Existing Warehouse")).count()).toBe(1);
  });

  it("exactly one candidate via fieldMatch fallback locator (no marker field available)", async () => {
    await page.setContent(TABLE_PAGE);
    const result = await rollback(page, {
      kind: "fieldMatch",
      inputValues: { Region: "East" },
      window: { from: new Date(0), to: new Date() },
    });
    expect(result).toEqual({ status: "OK" });
    expect(await (page.getByText("Existing Warehouse")).count()).toBe(0);
  });

  it("delete click fires but row survives verification → FAILED 'delete did not take effect'", async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <table>
          <tr><th>Name</th><th>Actions</th></tr>
          <tr><td>silly-rabbit-test-stuckrow Ghost</td><td><button type="button">Delete</button></td></tr>
        </table>
      </body></html>
    `);
    const result = await rollback(page, { kind: "marker", marker: "silly-rabbit-test-stuckrow" });
    expect(result).toEqual({ status: "FAILED", reason: "delete did not take effect" });
  });

  it("clicks a confirm dialog if one appears before verifying", async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <table>
          <tr><th>Name</th><th>Actions</th></tr>
          <tr>
            <td>silly-rabbit-test-confirmrow Item</td>
            <td>
              <button type="button" onclick="document.getElementById('confirm').style.display = 'inline'">Delete</button>
              <button id="confirm" type="button" style="display:none" onclick="document.querySelector('tr:nth-child(2)').remove()">Confirm</button>
            </td>
          </tr>
        </table>
      </body></html>
    `);
    const result = await rollback(page, { kind: "marker", marker: "silly-rabbit-test-confirmrow" });
    expect(result).toEqual({ status: "OK" });
  });

  it("routes the delete click through onBeforeRollbackDelete with verifiedMarkerMatch=true, not onBeforeAction", async () => {
    await page.setContent(TABLE_PAGE);
    const calls: { action: ActionDescriptor; verifiedMarkerMatch: boolean }[] = [];
    await rollback(
      page,
      { kind: "marker", marker: "silly-rabbit-test-a1b2c3d4" },
      {
        onBeforeRollbackDelete: (action, verifiedMarkerMatch) => {
          calls.push({ action, verifiedMarkerMatch });
        },
      },
    );
    expect(calls).toEqual([{ action: { role: "button", accessibleName: "Delete" }, verifiedMarkerMatch: true }]);
  });
});
