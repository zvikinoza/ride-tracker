/* Ride tracker — reads config.json + data/*.json and draws the route. No build step. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 30 * 60 * 1000; // re-check data every 30 min; the feed itself updates every 2 h
  const bust = () => "?v=" + Math.floor(Date.now() / (5 * 60 * 1000));
  const STYLE = {
    light: "https://tiles.openfreemap.org/styles/positron",
    dark: "https://tiles.openfreemap.org/styles/dark",
  };

  let map, config, lastFix, styleReady = false;
  let markers = [];
  let geo = { type: "FeatureCollection", features: [] };

  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ---------- geometry ----------
  const R = 6371;
  function haversine(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /* Unwrap longitudes so a route that crosses the antimeridian stays continuous
     (MapLibre happily draws at lon > 180 on the neighbouring world copy). */
  function unwrap(points) {
    let offset = 0, prev = null;
    return points.map((p) => {
      if (prev !== null) {
        if (p.lon - prev > 180) offset -= 360;
        else if (p.lon - prev < -180) offset += 360;
      }
      prev = p.lon;
      return { ...p, x: p.lon + offset };
    });
  }

  /* Split the track into ridden segments and transfers (flights, ferries, trains).
     A hop counts as a transfer when it is long AND implausibly fast for a bicycle. */
  function analyse(points, cfg) {
    const minKm = cfg.transfer_min_km ?? 15;
    const maxKmh = cfg.transfer_speed_kmh ?? 40;
    const pts = unwrap(points);
    const segments = [];
    let cur = { type: "ride", coords: [] };
    let km = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i === 0) { cur.coords.push([p.x, p.lat]); continue; }
      const prev = pts[i - 1];
      const d = haversine(prev, p);
      const hours = Math.max((Date.parse(p.t) - Date.parse(prev.t)) / 3.6e6, 1 / 60);
      if (d > minKm && d / hours > maxKmh) {
        if (cur.coords.length > 1) segments.push(cur);
        segments.push({ type: "transfer", coords: [[prev.x, prev.lat], [p.x, p.lat]] });
        cur = { type: "ride", coords: [[p.x, p.lat]] };
      } else {
        if (d > 0.03) km += d; // ignore GPS jitter while stopped
        cur.coords.push([p.x, p.lat]);
      }
    }
    if (cur.coords.length > 1) segments.push(cur);
    return { segments, km, pts };
  }

  // ---------- formatting ----------
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  function relTime(iso) {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 2) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.round(h / 24);
    if (d === 1) return "yesterday";
    if (d < 30) return `${d} days ago`;
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  function dayCount(start) {
    const s = new Date(start + "T00:00:00");
    return Math.max(1, Math.floor((Date.now() - s.getTime()) / 864e5) + 1);
  }
  const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  // ---------- map ----------
  function initMap() {
    map = new maplibregl.Map({
      container: "map",
      style: dark.matches ? STYLE.dark : STYLE.light,
      center: [20, 30],
      zoom: 1.6,
      attributionControl: { compact: window.innerWidth < 640 },
      cooperativeGestures: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("style.load", addLayers);
    // Compact attribution (phones) pops open once attributions arrive; fold it the first time, leave taps alone.
    const attrib = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
    if (attrib) {
      const obs = new MutationObserver(() => {
        if (attrib.classList.contains("maplibregl-compact-show")) {
          attrib.classList.remove("maplibregl-compact-show");
          attrib.removeAttribute("open");
          obs.disconnect();
        }
      });
      obs.observe(attrib, { attributes: true, attributeFilter: ["class", "open"] });
      setTimeout(() => obs.disconnect(), 60000);
    }
    dark.addEventListener("change", () => {
      styleReady = false;
      map.setStyle(dark.matches ? STYLE.dark : STYLE.light);
    });
  }

  function addLayers() {
    const accent = css("--accent"), casing = css("--casing"), transfer = css("--transfer");
    if (!map.getSource("route")) map.addSource("route", { type: "geojson", data: geo });
    else map.getSource("route").setData(geo);
    const ride = ["==", ["get", "type"], "ride"];
    map.addLayer({ id: "route-casing", type: "line", source: "route", filter: ride,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": casing, "line-width": 6, "line-opacity": 0.9 } });
    map.addLayer({ id: "route-transfer", type: "line", source: "route", filter: ["==", ["get", "type"], "transfer"],
      paint: { "line-color": transfer, "line-width": 1.5, "line-dasharray": [1, 4], "line-opacity": 0.9 } });
    map.addLayer({ id: "route-ride", type: "line", source: "route", filter: ride,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": accent, "line-width": 2.5, "line-opacity": 0.95 } });
    styleReady = true;
  }

  function popup(el, html) {
    const p = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "quiet", offset: 12 });
    return p.setHTML(html);
  }

  function draw(points) {
    const { segments, pts } = analyse(points, config);
    geo = { type: "FeatureCollection", features: segments.map((s) => ({
      type: "Feature", properties: { type: s.type }, geometry: { type: "LineString", coordinates: s.coords } })) };
    if (styleReady) map.getSource("route").setData(geo);

    markers.forEach((m) => m.remove());
    markers = [];
    if (!pts.length) return;
    const first = pts[0], last = pts[pts.length - 1];

    const s = document.createElement("div"); s.className = "start";
    markers.push(new maplibregl.Marker({ element: s }).setLngLat([first.x, first.lat])
      .setPopup(popup(s, `Started here · ${config.start_place || fmtDate(config.start_date)}`)).addTo(map));
    const h = document.createElement("div"); h.className = "here";
    markers.push(new maplibregl.Marker({ element: h }).setLngLat([last.x, last.lat])
      .setPopup(popup(h, `Latest fix · ${relTime(last.t)}`)).addTo(map));
    for (const m of markers) {
      const el = m.getElement();
      el.addEventListener("mouseenter", () => { if (!m.getPopup().isOpen()) m.togglePopup(); });
      el.addEventListener("mouseleave", () => { if (m.getPopup().isOpen()) m.togglePopup(); });
    }
  }

  function fit(points) {
    if (!points.length) return;
    const pts = unwrap(points);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.lat);
    const small = window.innerWidth < 640;
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], {
      padding: small ? { top: 100, left: 30, bottom: 250, right: 30 } : { top: 100, left: 360, bottom: 60, right: 60 },
      maxZoom: 12,
      animate: false,
    });
  }

  // ---------- data ----------
  async function loadJSON(url, optional) {
    try {
      const r = await fetch(url + bust(), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      if (optional) return null;
      throw e;
    }
  }

  function render(points, summary) {
    const { km } = analyse(points, config);
    $("km").textContent = points.length ? fmtInt(km) : "—";
    $("days").textContent = fmtInt(dayCount(config.start_date));

    const dot = document.querySelector(".dot");
    if (points.length) {
      lastFix = points[points.length - 1];
      const ageH = (Date.now() - Date.parse(lastFix.t)) / 3.6e6;
      dot.classList.toggle("stale", ageH > 36);
      const place = summary && summary.place ? ` · near ${summary.place}` : "";
      $("last").textContent = `Last seen ${relTime(lastFix.t)}${place}`;
      $("locate").title = `${lastFix.lat.toFixed(4)}, ${lastFix.lon.toFixed(4)}`;
    } else {
      dot.classList.add("stale");
      $("last").textContent = "Waiting for the first fix…";
    }

    const parts = [];
    if (config.start_date) parts.push(`Left ${config.start_place ? config.start_place + " on " : ""}${fmtDate(config.start_date)}`);
    if (points.length) parts.push(`${fmtInt(points.length)} tracker fixes`);
    $("meta").textContent = parts.join(" · ");

    const links = (config.links || []).filter((l) => l.url);
    $("links").innerHTML = links.map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`).join("");
  }

  async function refresh(first) {
    const base = config.demo ? "data/demo-" : "data/";
    const [track, summary] = await Promise.all([loadJSON(base + "track.json"), loadJSON(base + "summary.json", true)]);
    const points = (track.points || []).slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    render(points, summary);
    draw(points);
    if (first) fit(points);
    document.title = `${config.rider} · ${config.title}`;
  }

  async function main() {
    config = await loadJSON("config.json");
    $("title").textContent = config.title || "Around the world by bicycle";
    $("rider").textContent = config.rider || "";
    initMap();
    $("locate").addEventListener("click", () => {
      if (lastFix) map.flyTo({ center: [lastFix.lon, lastFix.lat], zoom: Math.max(map.getZoom(), 9), duration: 1400 });
    });
    try {
      await refresh(true);
    } catch (e) {
      $("last").textContent = "Could not load the track.";
      console.error(e);
    }
    setInterval(() => refresh(false).catch(console.error), REFRESH_MS);
  }

  main();
})();
