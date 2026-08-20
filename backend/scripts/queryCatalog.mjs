// Try simplest possible catalog queries
const attempts = [
  { name: "simple match_all", body: { size: 5, query: { match_all: {} } } },
  { name: "simple query_string", body: { size: 5, query: { query_string: { query: "industrial" } } } },
  { name: "simple bool", body: { size: 5, query: { bool: { must: [{ query_string: { query: "industrial" } }] } } } }
];

for (const a of attempts) {
  const res = await fetch("https://sdi.eea.europa.eu/catalogue/srv/api/search/records/_search?bucket=s101", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(a.body)
  });
  const text = await res.text();
  console.log(`[${a.name}] status: ${res.status}, len: ${text.length}`);
  if (res.ok) {
    const j = JSON.parse(text);
    console.log("  hits:", j.hits?.total?.value);
    for (const h of (j.hits?.hits || []).slice(0, 3)) {
      console.log("  -", h._source?.resourceTitleObject?.default, "|", h._source?.uuid);
    }
  } else {
    console.log("  err:", text.slice(0, 200));
  }
}