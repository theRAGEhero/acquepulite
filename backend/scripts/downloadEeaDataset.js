// Downloads the EEA "Industrial reporting dataset" using Playwright.
// The EEA portal builds the file client-side (blob) — we patch the anchor
// click handler to capture the blob, then read it out of the page.
// Run: node scripts/downloadEeaDataset.js

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(import.meta.dirname, "..", "data", "eea");
const DATASET_PAGE = "https://industry.eea.europa.eu/industrial-emissions/dataset";

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  console.log("[EEA] Opening dataset page…");
  await page.goto(DATASET_PAGE, { waitUntil: "networkidle", timeout: 120000 });
  console.log("[EEA] Waiting for connector data to load…");
  await page.waitForTimeout(15000);

  // Patch anchor clicks to capture blob downloads
  await page.evaluate(() => {
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.href && this.href.startsWith("blob:")) {
        fetch(this.href).then(r => r.blob()).then(async (b) => {
          const buf = await b.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          window.__capturedBlob = {
            name: this.download || "download",
            type: b.type,
            size: b.size,
            base64: btoa(binary)
          };
        });
      }
      return origClick.call(this);
    };
  });

  console.log("[EEA] Clicking 'Industrial reporting dataset' Download…");
  const textEl = page.getByText("Industrial reporting dataset", { exact: false }).first();
  if (!(await textEl.count())) throw new Error("Card text not found");

  let container = textEl;
  let dlBtn = null;
  for (let i = 0; i < 6; i++) {
    container = container.locator("..");
    const dl = container.locator('a, button').filter({ hasText: /^Download$/i });
    if ((await dl.count()) > 0) { dlBtn = dl.first(); break; }
  }
  if (!dlBtn) throw new Error("Download button not found");
  await dlBtn.click();

  // Wait for the blob capture (fix: timeout goes in the options object)
  const capture = await page.waitForFunction(
    () => window.__capturedBlob != null,
    null,
    { timeout: 600000, polling: 5000 }
  );
  const data = await capture.jsonValue();
  console.log(`[EEA] Captured blob: ${data.name} (${data.size} bytes, ${data.type})`);

  const dest = path.join(OUT_DIR, data.name || "eea_dataset");
  fs.writeFileSync(dest, Buffer.from(data.base64, "base64"));
  console.log(`[EEA] Saved: ${dest} (${fs.statSync(dest).size} bytes)`);

  await browser.close();
  console.log("[EEA] Done. Restart the backend to import the dataset.");
}

main().catch((e) => {
  console.error("[EEA] Failed:", e.message);
  process.exit(1);
});