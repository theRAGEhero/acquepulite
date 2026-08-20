// Find child records of the EEA industrial reporting series
import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Open catalog to get session, then query children via fetch in page context
  await page.goto("https://sdi.eea.europa.eu/catalogue/srv/eng/catalog.search", {
    waitUntil: "networkidle",
    timeout: 120000
  });
  await page.waitForTimeout(8000);

  const result = await page.evaluate(async () => {
    const body = {
      from: 0,
      size: 50,
      sort: ["_score"],
      query: {
        bool: {
          must: [{ query_string: { query: 'parentUuid:9405f714-8015-4b5b-a63c-280b82861b3d' } }]
        }
      }
    };
    const res = await fetch("/catalogue/srv/api/search/records/_search?bucket=s101", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    return (j.hits?.hits || []).map(h => ({
      title: h._source?.resourceTitleObject?.default,
      uuid: h._source?.uuid,
      type: h._source?.resourceType?.[0],
      links: (h._source?.link || []).map(l => ({ protocol: l.protocol, name: l.name, url: l.url }))
    }));
  });

  console.log("children:", result.length);
  for (const r of result) {
    console.log("---");
    console.log("title:", r.title);
    console.log("uuid:", r.uuid, "| type:", r.type);
    for (const l of r.links) {
      console.log("  link:", l.protocol, "|", l.name, "|", l.url);
    }
  }
  await browser.close();
}

main().catch((e) => { console.error("[DBG] Failed:", e.message); process.exit(1); });