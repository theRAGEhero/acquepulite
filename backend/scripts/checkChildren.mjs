// Check child records via JSON API for download links
const uuids = [
  "782307b9-386a-44b4-bcbf-192d36be40df", "2f792bc1-25f4-4a9c-b124-498271d62d12",
  "964f836d-4f64-4890-93e1-73cb3548b564", "faed8446-f02b-4bcd-9894-dbc4e5ad1b1d",
  "0e2e16ac-06e9-40b8-9aef-b3d228100564", "34acd167-1d0e-47ca-89a6-9f34d0d31de9",
  "6c57041c-c1c0-41ab-860d-e3e7b8c57a61", "6d03647a-8b79-4dac-b5de-beaefd14f7a3",
  "66b897e6-e519-46d2-901f-68bedeca37ca", "35f3036f-d005-4bf8-9908-bab36fc64c36",
  "557c0349-62f9-4641-962f-7c78d7912d45", "3da7d329-beea-4a7b-89bc-d45fc1c4b8ac",
  "7b4324e4-14c9-4a43-a9b5-f67602aca871", "4cfcdff4-0741-48f8-a73b-8e794597fe54",
  "63a14e09-d1f5-490d-80cf-6921e4e69551", "29464d2c-4707-4775-805b-5267cb08fe86",
  "1f7bcc27-dbed-4156-a356-61c597326971", "9300ec51-d805-4507-9a52-22dabdd9424d",
  "cf5e54c1-be99-4426-bcad-baa26c4f27a0", "ff47e25d-5d4c-491d-b9ce-de17ca61fe6d",
  "dc7bbfa4-4bf4-40d0-ad38-737a26ed9a76", "21e758c6-a9ac-4a7d-a64a-19d2ba9eecb7",
  "bdae5454-f6a6-484e-9c82-318e101a7547", "3461f4ab-a3ee-4af2-bc11-95e651a8d0ba",
  "9f373400-35b7-4978-9a34-a3cf839e053f", "3bbf28cb-70e8-4073-8fe9-8c1d9c513f52",
  "657ac3cb-affa-4295-a4a9-27b4f539adab"
];

for (const uuid of uuids) {
  try {
    const res = await fetch(`https://sdi.eea.europa.eu/catalogue/srv/api/records/${uuid}`, {
      headers: { "Accept": "application/json" }
    });
    const j = await res.json();
    const title = j.resourceTitleObject?.default || j.title || "?";
    const links = j.link || [];
    const dl = links.filter(l => /download|file|zip|csv|xlsx/i.test((l.name || "") + (l.url || "") + (l.protocol || "")));
    console.log("---");
    console.log(`${title} [${uuid}] links:${links.length} dl:${dl.length}`);
    for (const l of dl.slice(0, 4)) {
      console.log("  ", l.protocol, "|", l.name, "|", l.url);
    }
  } catch (e) {
    console.log(`ERR ${uuid}: ${e.message}`);
  }
}