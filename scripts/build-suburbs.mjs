// Builds public/council-maps/suburbs.json — Auckland suburb outlines for the Council fields
// page (the 🔍 Auckland view highlights the park's suburb and outlines its neighbours).
//
// Source: LINZ "NZ Suburbs and Localities" (CC BY 4.0, https://data.linz.govt.nz/layer/113764).
// Either:
//   LINZ_API_KEY=<key> node scripts/build-suburbs.mjs          (downloads the Auckland area by WFS)
//   node scripts/build-suburbs.mjs path/to/suburbs.geojson     (a GeoJSON export from LINZ, WGS84 / NZGD2000;
//                                                                a shapefile export converts with e.g. ogr2ogr or pyshp)
//
// Output: { source, licence, built, suburbs: [{ n: name, b: [s, w, n, e], p: [[[lat, lon], …], …] }] }
// with polygons simplified to about 10 m and coordinates to 5 decimals.
import { readFileSync, writeFileSync } from "node:fs";

const AKL = { s: -37.45, w: 174.15, n: -36.05, e: 175.6 };   // the Auckland region, roughly
const TOL = 10;   // simplification tolerance (metres): plenty at suburb zoom

async function load() {
  const file = process.argv[2];
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const key = process.env.LINZ_API_KEY;
  if (!key) { console.error("Give a GeoJSON file, or set LINZ_API_KEY to download from LINZ."); process.exit(1); }
  const url = `https://data.linz.govt.nz/services;key=${key}/wfs?service=WFS&version=2.0.0&request=GetFeature`
    + `&typeNames=layer-113764&outputFormat=json&srsName=EPSG:4326`
    + `&bbox=${AKL.s},${AKL.w},${AKL.n},${AKL.e},urn:ogc:def:crs:EPSG::4326`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`LINZ ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
// Douglas–Peucker on [lat, lon] points, in metres.
function dp(pts) {
  if (pts.length < 3) return pts;
  const lat0 = pts[0][0], kx = 111319.49 * Math.cos(lat0 * Math.PI / 180), ky = 111319.49;
  const xy = pts.map(([la, lo]) => [lo * kx, la * ky]), keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let best = 0, at = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b], L = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - xy[i][1]) - (ax - xy[i][0]) * (by - ay)) / L; if (d > best) { best = d; at = i; } }
    if (best > TOL) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// A closed ring: split at the point farthest from the first, simplify each half, close it.
function simplify(ring) {
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
  if (pts.length < 4) return [...pts, pts[0]];
  let k = 1, far = 0; pts.forEach(([la, lo], i) => { const d = (la - pts[0][0]) ** 2 + (lo - pts[0][1]) ** 2; if (d > far) { far = d; k = i; } });
  const a = dp(pts.slice(0, k + 1)), b = dp([...pts.slice(k), pts[0]]);
  return [...a, ...b.slice(1)];
}
const r5 = v => +v.toFixed(5);
const gj = await load();
const out = [];
for (const f of gj.features || []) {
  const name = f.properties?.name || f.properties?.NAME || f.properties?.suburb_locality || "";
  const g = f.geometry; if (!g || !name) continue;
  // Suburbs and localities only (the layer also has coastal bays, islands and lakes).
  const type = f.properties?.type || f.properties?.TYPE; if (type && !/^(suburb|locality)$/i.test(type)) continue;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const rings = polys.map(poly => simplify(poly[0].map(([lo, la]) => [r5(la), r5(lo)]))).filter(r => r.length >= 4);   // outer rings only
  if (!rings.length) continue;
  const all = rings.flat(), lats = all.map(q => q[0]), lons = all.map(q => q[1]);
  const b = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  if (b[2] < AKL.s || b[0] > AKL.n || b[3] < AKL.w || b[1] > AKL.e) continue;
  out.push({ n: name, b, p: rings });
}
out.sort((a, b) => a.n.localeCompare(b.n));
writeFileSync(new URL("../public/council-maps/suburbs.json", import.meta.url),
  JSON.stringify({ source: "LINZ NZ Suburbs and Localities (layer 113764)", licence: "CC BY 4.0", built: new Date().toISOString(), suburbs: out }));
console.log(`Wrote ${out.length} suburbs to public/council-maps/suburbs.json`);
