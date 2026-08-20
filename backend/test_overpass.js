const q = '[out:json][timeout:20];(relation["waterway"="river"]["name"="Lambro"];way(r););out geom;';
const url = "https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q);
fetch(url, {
  method: "GET",
  headers: { "User-Agent": "RiverPollutionMap/1.0 (research)" }
}).then(r => { console.log("status", r.status); return r.text(); }).then(t => {
  try {
    const j = JSON.parse(t);
    const ways = j.elements.filter(e => e.type === "way");
    console.log("ways:", ways.length);
    if (ways[0]) {
      console.log("sample way nodes:", ways[0].geometry?.length);
      console.log("first coord:", JSON.stringify(ways[0].geometry?.[0]));
      const total = ways.reduce((s, w) => s + (w.geometry?.length || 0), 0);
      console.log("total coords:", total);
    }
  } catch(e) { console.log("body[:300]", t.slice(0, 300)); }
}).catch(e => console.error("ERR", e.message));