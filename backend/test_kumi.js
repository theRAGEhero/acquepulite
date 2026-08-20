const q = '[out:json][timeout:15];(relation["waterway"="river"]["name"="Lambro"];way(r););out geom;';
const url = "https://overpass.kumi.systems/api/interpreter?data=" + encodeURIComponent(q);
fetch(url, { headers: { "User-Agent": "RiverPollutionMap/1.0 (research)" } })
  .then(r => { console.log("status:", r.status); return r.text(); })
  .then(t => {
    console.log("body length:", t.length);
    try { const j = JSON.parse(t); const w = j.elements.filter(e => e.type === "way"); console.log("ways:", w.length, "coords:", w.reduce((s, x) => s + (x.geometry?.length || 0), 0)); }
    catch(e) { console.log("body[:200]:", t.slice(0, 200)); }
  })
  .catch(e => console.error("ERR", e.message));