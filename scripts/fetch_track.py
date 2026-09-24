#!/usr/bin/env python3
"""Pull new points from a Garmin inReach MapShare KML feed and merge them into data/track.json.

Standard library only. Run from the repo root:
    python scripts/fetch_track.py
Env:
    MAPSHARE_PASSWORD   password if the MapShare feed is protected (optional)
    NO_GEOCODE=1        skip the reverse-geocode lookup for the latest point
"""
import base64
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config.json"
TRACK = ROOT / "data" / "track.json"
SUMMARY = ROOT / "data" / "summary.json"
FEED = "https://share.garmin.com/Feed/Share/{id}"
KML = "{http://www.opengis.net/kml/2.2}"
UA = "ride-tracker/1.0 (+https://github.com)"


def log(*a):
    print(*a, file=sys.stderr)


def parse_time(s):
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s).astimezone(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_kml(mapshare_id, d1, d2, password=None):
    q = urllib.parse.urlencode({"d1": d1.strftime("%Y-%m-%dT%H:%M:%SZ"), "d2": d2.strftime("%Y-%m-%dT%H:%M:%SZ")})
    url = f"{FEED.format(id=mapshare_id)}?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if password:
        token = base64.b64encode(f":{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def parse_points(kml_bytes):
    """Return [{t, lat, lon, alt}] from every Placemark that has a Point and a TimeStamp."""
    root = ET.fromstring(kml_bytes)
    out = []
    for pm in root.iter(f"{KML}Placemark"):
        when = pm.find(f".//{KML}TimeStamp/{KML}when")
        coords = pm.find(f".//{KML}Point/{KML}coordinates")
        if when is None or coords is None or not coords.text:
            continue
        parts = coords.text.strip().split(",")
        if len(parts) < 2:
            continue
        lon, lat = float(parts[0]), float(parts[1])
        alt = float(parts[2]) if len(parts) > 2 and parts[2] else None
        if lat == 0 and lon == 0:
            continue
        p = {"t": iso(parse_time(when.text)), "lat": round(lat, 6), "lon": round(lon, 6)}
        if alt is not None:
            p["alt"] = round(alt)
        out.append(p)
    return out


def haversine(a, b):
    r = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    s = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(s))


def total_km(points, min_km, max_kmh):
    km = 0.0
    for prev, cur in zip(points, points[1:]):
        d = haversine(prev, cur)
        hours = max((parse_time(cur["t"]) - parse_time(prev["t"])).total_seconds() / 3600, 1 / 60)
        if d > min_km and d / hours > max_kmh:
            continue  # transfer: flight / ferry / train
        if d > 0.03:
            km += d
    return km


def reverse_geocode(lat, lon):
    q = urllib.parse.urlencode({"format": "jsonv2", "lat": lat, "lon": lon, "zoom": 10, "accept-language": "en"})
    req = urllib.request.Request(f"https://nominatim.openstreetmap.org/reverse?{q}", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.load(r)
    except Exception as e:  # geocoding is a nicety; never fail the run for it
        log("geocode failed:", e)
        return None
    a = j.get("address", {})
    town = a.get("city") or a.get("town") or a.get("village") or a.get("municipality") or a.get("county") or a.get("state")
    country = a.get("country")
    return ", ".join(x for x in (town, country) if x) or None


def main():
    cfg = json.loads(CONFIG.read_text())
    mapshare_id = cfg.get("mapshare_id", "")
    if not mapshare_id or mapshare_id == "YOUR_MAPSHARE_NAME":
        log("config.json: set mapshare_id first (the name in share.garmin.com/<name>). Nothing fetched.")
        return 0

    track = json.loads(TRACK.read_text()) if TRACK.exists() else {"points": []}
    by_time = {p["t"]: p for p in track.get("points", [])}

    now = datetime.now(timezone.utc)
    if by_time:
        d1 = parse_time(max(by_time)) - timedelta(days=1)  # small overlap; duplicates are dropped by timestamp
    else:
        d1 = datetime.fromisoformat(cfg["start_date"]).replace(tzinfo=timezone.utc)

    password = os.environ.get("MAPSHARE_PASSWORD") or None
    added = 0
    while d1 < now:  # fetch in 30-day windows so a long history isn't cut off
        d2 = min(d1 + timedelta(days=30), now + timedelta(hours=1))
        try:
            kml = fetch_kml(mapshare_id, d1, d2, password)
        except urllib.error.HTTPError as e:
            log(f"feed error {e.code} for {d1:%F}..{d2:%F}: {e.reason}")
            return 1
        pts = parse_points(kml)
        for p in pts:
            if p["t"] not in by_time:
                by_time[p["t"]] = p
                added += 1
        log(f"{d1:%F}..{d2:%F}: {len(pts)} points in feed, {added} new so far")
        d1 = d2

    points = sorted(by_time.values(), key=lambda p: p["t"])
    TRACK.write_text(json.dumps({"points": points}, separators=(",", ":")) + "\n")

    summary = {"updated": iso(now), "fixes": len(points)}
    if points:
        last = points[-1]
        summary["last"] = last
        summary["total_km"] = round(total_km(points, cfg.get("transfer_min_km", 15), cfg.get("transfer_speed_kmh", 40)), 1)
        old = json.loads(SUMMARY.read_text()) if SUMMARY.exists() else {}
        if old.get("last", {}).get("t") == last["t"] and old.get("place"):
            summary["place"] = old["place"]  # position unchanged: reuse, don't re-geocode
        elif not os.environ.get("NO_GEOCODE"):
            summary["place"] = reverse_geocode(last["lat"], last["lon"])
    SUMMARY.write_text(json.dumps(summary, indent=2) + "\n")
    log(f"{len(points)} points total, {added} added. Total {summary.get('total_km', 0)} km.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
