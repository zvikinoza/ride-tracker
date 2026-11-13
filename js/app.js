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
  const PLANE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>';

  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const TRAIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c-4 0-8 .5-8 4v9.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h2.23l2-2H14l2 2h2v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-3.58-4-8-4zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm3.5-7H6V6h5v4zm2 0V6h5v4h-5zm3.5 7c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>';
  const BUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/></svg>';
  const GROUND = { train: { svg: TRAIN_SVG, label: "Train" }, bus: { svg: BUS_SVG, label: "Bus" } };
  let map, config, lastFix, styleReady = false, earthStyleJSON = null;
  let markers = [];
  let summaryData = null, activeRec = null, recPopup = null, peakMarker = null;
  let highlight = { type: "FeatureCollection", features: [] };
  let geo = { type: "FeatureCollection", features: [] };

  // ---------- view (earth / map) and theme (light / dark chrome) ----------
  const root = document.documentElement;
  const isDark = () => root.dataset.theme === "dark";
  const isEarth = () => root.dataset.view !== "map";
  const remember = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

  /* Google-Earth-like style: satellite imagery on a globe, with the quiet map's borders and
     labels laid over it in white. Built once from the positron style so fonts/sources match. */
  async function earthStyle() {
    if (!earthStyleJSON) {
      const base = await (await fetch(STYLE.light)).json();
      const keep = base.layers.filter((l) => l.type === "symbol" || l.id.startsWith("boundary"));
      const layers = [
        { id: "satellite", type: "raster", source: "satellite", paint: { "raster-saturation": -0.1, "raster-brightness-max": 0.95 } },
        ...keep.map((l) => {
          const c = JSON.parse(JSON.stringify(l));
          if (c.type === "symbol") {
            c.paint = { ...c.paint, "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.65)", "text-halo-width": 1.3, "text-halo-blur": 0.6 };
          } else {
            c.paint = { ...c.paint, "line-color": "rgba(255,255,255,0.7)", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 8, 1.2] };
          }
          return c;
        }),
      ];
      earthStyleJSON = JSON.stringify({
        version: 8,
        projection: { type: "globe" },
        sky: {
          "sky-color": "#0b1526", "horizon-color": "#7fb0e0", "fog-color": "#cfe0f2",
          "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.9,
          "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 8, 1, 11, 0],
        },
        sprite: base.sprite, glyphs: base.glyphs,
        sources: { ...base.sources, satellite: { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 19,
          attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" } },
        layers,
      });
    }
    return JSON.parse(earthStyleJSON);
  }
  async function applyStyle() {
    styleReady = false;
    map.setStyle(isEarth() ? await earthStyle() : (isDark() ? STYLE.dark : STYLE.light));
  }
  function setTheme(name) {
    root.dataset.theme = name; remember("theme", name);
    if (map && !isEarth()) applyStyle();
    else if (map) draw(window.__points || []); // route colours follow the chrome
  }
  function setView(name) {
    root.dataset.view = name; remember("view", name);
    if (map) applyStyle();
  }
  class ViewToggle {
    onAdd() {
      this.el = document.createElement("div");
      this.el.className = "maplibregl-ctrl maplibregl-ctrl-group view-toggle";
      this.el.innerHTML = '<button type="button" title="Satellite / map" aria-label="Switch satellite / map">' +
        '<svg class="globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>' +
        '<svg class="mapicon" viewBox="0 0 24 24"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"/></svg></button>';
      this.el.querySelector("button").addEventListener("click", () => setView(isEarth() ? "map" : "earth"));
      return this.el;
    }
    onRemove() { this.el.remove(); }
  }
  class ThemeToggle {
    onAdd() {
      this.el = document.createElement("div");
      this.el.className = "maplibregl-ctrl maplibregl-ctrl-group theme-toggle";
      this.el.innerHTML = '<button type="button" title="Switch light / dark" aria-label="Switch light / dark">' +
        '<svg class="sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
        '<svg class="moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>';
      this.el.querySelector("button").addEventListener("click", () => setTheme(isDark() ? "light" : "dark"));
      return this.el;
    }
    onRemove() { this.el.remove(); }
  }
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();

  // ---------- geometry ----------
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180, toDeg = (r) => (r * 180) / Math.PI;
  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lon - a.lon);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  /* Great-circle arc from a to b as [x, lat] pairs, x continuing a's unwrapped longitude. */
  function arc(a, b, n = 64) {
    const φ1 = toRad(a.lat), λ1 = toRad(a.lon), φ2 = toRad(b.lat), λ2 = toRad(b.lon);
    const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
    const out = [];
    let prevLon = a.lon, offset = a.x - a.lon;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      if (d === 0) { out.push([a.x, a.lat]); continue; }
      const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
      const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
      const z = A * Math.sin(φ1) + B * Math.sin(φ2);
      const lat = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon = toDeg(Math.atan2(y, x));
      if (lon - prevLon > 180) offset -= 360; else if (lon - prevLon < -180) offset += 360;
      prevLon = lon;
      out.push([lon + offset, lat]);
    }
    return out;
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

  /* Split the track into ridden segments, flights and other transfers (ferry, train, bus).
     A hop counts as a transfer when it is long AND implausibly fast for a bicycle;
     a transfer longer than flight_min_km is a flight and is drawn as a great-circle arc. */
  function analyse(points, cfg) {
    const minKm = cfg.transfer_min_km ?? 15;
    const maxKmh = cfg.transfer_speed_kmh ?? 40;
    const flightKm = cfg.flight_min_km ?? 400;
    const pts = unwrap(points);
    const segments = [];
    let cur = { type: "ride", coords: [] };
    let km = 0, flights = 0;
    const ground = {}; // count of labelled ground transfers by mode: { train: 1, bus: 1 }
    const known = cfg.transfers || []; // e.g. [{ "from": "2026-10-10", "mode": "train" }], matched on the UTC date the gap starts
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i === 0) { cur.coords.push([p.x, p.lat]); continue; }
      const prev = pts[i - 1];
      const d = haversine(prev, p);
      const hours = Math.max((Date.parse(p.t) - Date.parse(prev.t)) / 3.6e6, 1 / 60);
      const gap = p.s === 1 && d > 3; // Strava: a new ride starting away from where the last one ended
      if (gap || (d > minKm && d / hours > maxKmh)) {
        if (cur.coords.length > 1) segments.push(cur);
        const override = known.find((k) => k.from === prev.t.slice(0, 10));
        const mode = override ? override.mode : (d >= flightKm ? "flight" : "transfer");
        const coords = d > 100 ? arc(prev, p, mode === "flight" ? 64 : 32) : [[prev.x, prev.lat], [p.x, p.lat]];
        const mid = coords[Math.floor(coords.length / 2)];
        if (mode === "flight") {
          flights++;
          segments.push({ type: "flight", coords, km: d, mid, heading: bearing({ lat: mid[1], lon: mid[0] }, p) });
        } else {
          if (GROUND[mode]) ground[mode] = (ground[mode] || 0) + 1;
          segments.push({ type: mode, coords, km: d, mid });
        }
        cur = { type: "ride", coords: [[p.x, p.lat]] };
      } else {
        if (d > 0.03) km += d; // ignore GPS jitter while stopped
        cur.coords.push([p.x, p.lat]);
      }
    }
    if (cur.coords.length > 1) segments.push(cur);
    return { segments, km, flights, ground, pts };
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
      style: isDark() ? STYLE.dark : STYLE.light, // swapped for the earth style right after
      center: [40, 42],
      zoom: 2,
      attributionControl: { compact: window.innerWidth < 640 },
      cooperativeGestures: false,
    });
    window.__map = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new ViewToggle(), "top-right");
    map.addControl(new ThemeToggle(), "top-right");
    map.on("style.load", addLayers);
    if (isEarth()) applyStyle();

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
  }

  /* Calm the basemap labels: one language per name, no villages/regions/road names,
     cities only from mid zoom, and more breathing room between labels. */
  function quietLabels() {
    const HIDE = /^(label_other|label_village|label_state|highway-|road_shield|waterway_line_label|water_name_line_label|airport|place_other|place_suburb|place_village|place_state|highway_name|road_oneway)/;
    const LATE = { label_town: 8, place_town: 8, label_city: 5, place_city: 5, place_city_large: 4 };
    for (const layer of map.getStyle().layers) {
      if (layer.type !== "symbol") continue;
      if (HIDE.test(layer.id)) { map.setLayoutProperty(layer.id, "visibility", "none"); continue; }
      map.setLayoutProperty(layer.id, "text-field", ["coalesce", ["get", "name_en"], ["get", "name:latin"], ["get", "name"]]);
      map.setLayoutProperty(layer.id, "text-padding", 14);
      if (LATE[layer.id]) map.setLayerZoomRange(layer.id, LATE[layer.id], layer.maxzoom ?? 24);
    }
  }

  function addLayers() {
    quietLabels();
    const accent = css("--accent"), casing = css("--casing"), transfer = css("--transfer");
    if (!map.getSource("route")) map.addSource("route", { type: "geojson", data: geo });
    else map.getSource("route").setData(geo);
    const is = (t) => ["==", ["get", "type"], t];
    map.addLayer({ id: "route-casing", type: "line", source: "route", filter: is("ride"),
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": casing, "line-width": 8, "line-opacity": 0.9 } });
    map.addLayer({ id: "route-transfer", type: "line", source: "route", filter: is("transfer"),
      paint: { "line-color": transfer, "line-width": 1.5, "line-dasharray": [1, 4], "line-opacity": 0.9 } });
    map.addLayer({ id: "route-train", type: "line", source: "route", filter: ["in", ["get", "type"], ["literal", Object.keys(GROUND)]],
      layout: { "line-cap": "round" },
      paint: { "line-color": transfer, "line-width": 2.6, "line-dasharray": [0.2, 2.2], "line-opacity": 0.95 } });
    map.addLayer({ id: "route-flight", type: "line", source: "route", filter: is("flight"),
      paint: { "line-color": transfer, "line-width": 2.6, "line-dasharray": [2.2, 1.8], "line-opacity": 0.95 } });
    map.addLayer({ id: "route-ride", type: "line", source: "route", filter: is("ride"),
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": accent, "line-width": 4, "line-opacity": 0.95 } });
    if (!map.getSource("highlight")) map.addSource("highlight", { type: "geojson", data: highlight });
    map.addLayer({ id: "route-highlight-casing", type: "line", source: "highlight",
      layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "rgba(0,0,0,0.45)", "line-width": 9 } });
    map.addLayer({ id: "route-highlight", type: "line", source: "highlight",
      layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffd35c", "line-width": 5 } });
    styleReady = true;
  }

  function popup(html) {
    return new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "quiet", offset: 14 }).setHTML(html);
  }
  function addMarker(el, lngLat, html, opts = {}) {
    // opacityWhenCovered "0": fully hidden on the far side of the globe (MapLibre's default leaves a faded ghost)
    const m = new maplibregl.Marker({ element: el, opacityWhenCovered: "0", ...opts }).setLngLat(lngLat).setPopup(popup(html)).addTo(map);
    el.addEventListener("mouseenter", () => { if (!m.getPopup().isOpen()) m.togglePopup(); });
    el.addEventListener("mouseleave", () => { if (m.getPopup().isOpen()) m.togglePopup(); });
    markers.push(m);
  }

  function draw(points) {
    const { segments, pts } = analyse(points, config);
    geo = { type: "FeatureCollection", features: segments.map((s) => ({
      type: "Feature", properties: { type: s.type }, geometry: { type: "LineString", coordinates: s.coords } })) };
    window.__points = points;
    if (styleReady) map.getSource("route").setData(geo);

    markers.forEach((m) => m.remove());
    markers = [];
    if (!pts.length) return;
    const first = pts[0], last = pts[pts.length - 1];

    for (const s of segments) {
      if (s.type !== "flight" && !GROUND[s.type]) continue;
      const el = document.createElement("div"); el.className = "plane";
      if (s.type === "flight") {
        el.innerHTML = PLANE_SVG;
        el.firstChild.style.transform = `rotate(${Math.round(s.heading)}deg)`;
        addMarker(el, s.mid, `Flight · ${fmtInt(s.km)} km, not counted`);
      } else {
        el.innerHTML = GROUND[s.type].svg;
        addMarker(el, s.mid, `${GROUND[s.type].label} · ${fmtInt(s.km)} km, not counted`);
      }
    }
    const st = document.createElement("div"); st.className = "start";
    addMarker(st, [first.x, first.lat], `Started here · ${config.start_place || fmtDate(config.start_date)}`);
    const here = document.createElement("div"); here.className = "here"; here.innerHTML = '<span class="ring2"></span>';
    addMarker(here, [last.x, last.lat], `Latest position · ${relTime(last.t)}`);
  }

  const uiPadding = () => (window.innerWidth < 640
    ? { top: 110, left: 20, bottom: 260, right: 20 }
    : { top: 80, left: 180, bottom: 40, right: 40 });

  /* First view: a regional look around where they are now (the whole route is a zoom-out away). */
  function fit(points) {
    if (!points.length) return;
    const last = points[points.length - 1];
    map.jumpTo({ center: [last.lon, last.lat], zoom: window.innerWidth < 640 ? 2.4 : 4.3, padding: uiPadding() });
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
    const a = analyse(points, config);
    const km = summary && typeof summary.total_km === "number" ? summary.total_km : a.km; // Strava's own total when we have it
    const flights = a.flights;
    $("km").textContent = points.length ? fmtInt(km) : "—";
    $("days").textContent = fmtInt(dayCount(config.start_date));

    const dot = document.querySelector(".dot");
    if (points.length) {
      lastFix = points[points.length - 1];
      const ageH = (Date.now() - Date.parse(lastFix.t)) / 3.6e6;
      dot.classList.toggle("stale", ageH > 36);
      const place = summary && summary.place ? ` · near ${summary.place}` : "";
      const verb = summary && summary.source === "strava" ? "Last ride" : "Last seen";
      $("last").textContent = `${verb} ${relTime(lastFix.t)}${place}`;
      $("locate").title = `${lastFix.lat.toFixed(4)}, ${lastFix.lon.toFixed(4)}`;
    } else {
      dot.classList.add("stale");
      $("last").textContent = "Waiting for the first fix…";
    }

    renderSponsorStats(km, points);
    renderRecords(summary);

    const parts = [];
    if (config.start_date) parts.push(`Left ${config.start_place ? config.start_place + " on " : ""}${fmtDate(config.start_date)}`);
    if (flights) parts.push(`${flights} flight${flights === 1 ? "" : "s"}`);
    for (const [mode, n] of Object.entries(a.ground)) parts.push(`${n} ${mode}${n === 1 ? "" : mode === "bus" ? "es" : "s"}`);
    $("meta").textContent = parts.join(" · ");

    const links = (config.links || []).filter((l) => l.url);
    $("links").innerHTML = links.map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`).join("");
  }

  /* Estimated litres drunk and GB used, from configurable rates; the bottle fills through their local day. */
  function renderSponsorStats(km, points) {
    const sp = config.sponsors || {};
    const box = $("sponsor-stats");
    if (!sp.water && !sp.data) { box.hidden = true; return; }
    const brand = (s, cls) => {
      const inner = s.logo ? `<img class="brand-img ${cls}" src="${s.logo}" alt="${s.name}">` : s.name;
      return s.url ? `<a href="${s.url}" target="_blank" rel="noopener" title="${s.name}">${inner}</a>` : inner;
    };
    const days = dayCount(config.start_date);
    if (sp.water) {
      const litres = (km / 100) * (sp.water.litres_per_100km ?? 8) + (sp.water.litres_extra ?? 0);
      $("litres").textContent = `≈ ${fmtInt(litres)} L`;
      $("litres-label").innerHTML = `${brand(sp.water, "water")} <span>drunk</span>`;
      if (sp.water.icon) $("water-icon").src = sp.water.icon;
    }
    if (sp.data) {
      const gb = days * (sp.data.gb_per_day ?? 3) + (sp.data.gb_extra ?? 0);
      $("gb").textContent = `≈ ${fmtInt(gb)} GB`;
      $("gb-label").innerHTML = `${brand(sp.data, "data")} <span>data used</span>`;
      if (sp.data.color) $("data-icon").style.fill = sp.data.color;
    }
    box.hidden = false;
  }

  // ---------- record days ----------
  const shortDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const hm = (s) => `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
  const REC = {
    furthest: { value: (r) => `${fmtInt(r.km)} km`, title: "Furthest day" },
    longest: { value: (r) => hm(r.moving_s), title: "Longest day in the saddle", extra: (r) => `${fmtInt(r.km)} km` },
    climb: { value: (r) => `${fmtInt(r.m)} m`, title: "Most climbing in a day", extra: (r) => `${fmtInt(r.km)} km` },
    highest: { value: (r) => `${fmtInt(r.m)} m`, title: "Highest point", extra: (r) => r.place || "" },
  };

  function renderRecords(summary) {
    summaryData = summary;
    const recs = (summary && summary.records) || {};
    const box = $("records");
    let any = false;
    box.querySelectorAll(".rec").forEach((el) => {
      const r = recs[el.dataset.rec];
      el.hidden = !r;
      if (!r) return;
      any = true;
      el.querySelector(".rec-num").textContent = REC[el.dataset.rec].value(r);
      el.querySelector(".rec-date").textContent = shortDate(r.date);
      el.title = `${REC[el.dataset.rec].title} · ${fmtDate(r.date)} · tap to show on the map`;
    });
    box.hidden = !any;
  }

  function clearRecord() {
    activeRec = null;
    highlight = { type: "FeatureCollection", features: [] };
    if (styleReady && map.getSource("highlight")) map.getSource("highlight").setData(highlight);
    if (recPopup) { recPopup.remove(); recPopup = null; }
    if (peakMarker) { peakMarker.remove(); peakMarker = null; }
    document.querySelectorAll(".rec.on").forEach((el) => el.classList.remove("on"));
  }

  /* Highlight the record day's ride(s), fly there and label it. Tapping the same tile again clears it. */
  function showRecord(key) {
    const r = summaryData && summaryData.records && summaryData.records[key];
    if (!r) return;
    if (activeRec === key) { clearRecord(); return; }
    clearRecord();
    const pts = unwrap(window.__points || []).filter((p) => p.t >= r.from && p.t <= r.to);
    if (!pts.length) return;
    const lines = [];
    for (const p of pts) {
      if (p.s === 1 || !lines.length) lines.push([]);
      lines[lines.length - 1].push([p.x, p.lat]);
    }
    highlight = { type: "FeatureCollection", features: lines.filter((l) => l.length > 1).map((l) => ({
      type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: l } })) };
    if (styleReady) map.getSource("highlight").setData(highlight);
    activeRec = key;
    document.querySelector(`.rec[data-rec="${key}"]`).classList.add("on");

    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.lat);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: uiPadding(), maxZoom: 9.5, duration: 1600 });

    let at = [pts[Math.floor(pts.length / 2)].x, pts[Math.floor(pts.length / 2)].lat];
    if (key === "highest" && r.lat != null) {
      const near = pts.reduce((b, p) => (Math.abs(p.lat - r.lat) + Math.abs(p.lon - r.lon) < Math.abs(b.lat - r.lat) + Math.abs(b.lon - r.lon) ? p : b));
      at = [near.x, near.lat];
      const el = document.createElement("div"); el.className = "peak";
      peakMarker = new maplibregl.Marker({ element: el, anchor: "bottom", opacityWhenCovered: "0" }).setLngLat(at).addTo(map);
    }
    const extra = REC[key].extra ? REC[key].extra(r) : "";
    recPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "quiet", offset: 16 })
      .setLngLat(at)
      .setHTML(`${REC[key].title} · ${REC[key].value(r)}<br>${fmtDate(r.date)}${extra ? " · " + extra : ""}`)
      .addTo(map);
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
    document.querySelectorAll(".rec").forEach((el) => el.addEventListener("click", () => showRecord(el.dataset.rec)));
    $("locate").addEventListener("click", () => {
      clearRecord();
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
