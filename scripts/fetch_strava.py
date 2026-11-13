#!/usr/bin/env python3
"""Pull rides from Strava and merge them into data/track.json (same point format as the MapShare feed).

Standard library only. Env:
    STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN   (GitHub secrets)
    NO_GEOCODE=1  skip the place-name lookup
Each ride's GPS line is thinned to ~one point per 300 m and given interpolated timestamps, so the site
draws exact roads while the total distance comes straight from Strava (data/summary.json: total_km).
"""
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_track import haversine, iso, parse_time, reverse_geocode, log  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config.json"
TRACK = ROOT / "data" / "track.json"
RIDES = ROOT / "data" / "rides.json"
SUMMARY = ROOT / "data" / "summary.json"
API = "https://www.strava.com/api/v3"
RIDE_TYPES = {"Ride", "GravelRide", "MountainBikeRide", "EBikeRide", "EMountainBikeRide", "Handcycle", "Velomobile"}
THIN_KM = 0.3


def decode_polyline(s):
    """Google encoded polyline -> [(lat, lon)]."""
    out, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63; i += 1
                result |= (b & 0x1F) << shift; shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0: lat += d
            else: lon += d
        out.append((lat / 1e5, lon / 1e5))
    return out


def access_token():
    cid, sec, rt = (os.environ.get(k) for k in ("STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN"))
    if not (cid and sec and rt):
        raise SystemExit("Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN")
    data = urllib.parse.urlencode({"client_id": cid, "client_secret": sec, "refresh_token": rt, "grant_type": "refresh_token"}).encode()
    with urllib.request.urlopen(urllib.request.Request(f"{API.replace('/api/v3', '')}/oauth/token", data=data), timeout=30) as r:
        j = json.load(r)
    if j.get("refresh_token") and j["refresh_token"] != rt:
        # Never print the token: this log is public. If fetches start failing with 401, re-authorize (README).
        log("NOTE: Strava rotated the refresh token; the stored secret may stop working. Re-authorize if runs begin to fail.")
    return j["access_token"]


def api(token, path, **params):
    url = f"{API}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                log("rate limited, waiting 60 s"); time.sleep(60); continue
            raise


def ride_points(act, detail):
    """Thin the ride's polyline and spread timestamps over its elapsed time."""
    poly = (detail.get("map") or {}).get("polyline") or (act.get("map") or {}).get("summary_polyline")
    if not poly:
        return []
    coords = decode_polyline(poly)
    if len(coords) < 2:
        return []
    kept, acc = [coords[0]], 0.0
    for a, b in zip(coords, coords[1:]):
        acc += haversine({"lat": a[0], "lon": a[1]}, {"lat": b[0], "lon": b[1]})
        if acc >= THIN_KM:
            kept.append(b); acc = 0.0
    if kept[-1] != coords[-1]:
        kept.append(coords[-1])
    t0 = parse_time(act["start_date"]).timestamp()
    span = max(float(act.get("elapsed_time") or 3600), 60.0)
    dist = [0.0]
    for a, b in zip(kept, kept[1:]):
        dist.append(dist[-1] + haversine({"lat": a[0], "lon": a[1]}, {"lat": b[0], "lon": b[1]}))
    total = dist[-1] or 1.0
    out = [{"t": iso(datetime.fromtimestamp(t0 + span * d / total, timezone.utc)), "lat": round(la, 5), "lon": round(lo, 5)}
           for (la, lo), d in zip(kept, dist)]
    out[0]["s"] = 1  # first point of a ride: the site treats the hop from the previous ride as a gap, not riding
    return out


def ride_meta(act):
    """Per-ride facts kept in rides.json (all available from the activity list, no extra API call)."""
    return {"name": act.get("name"), "start": act["start_date"], "start_local": act.get("start_date_local") or act["start_date"],
            "km": round(act.get("distance", 0) / 1000, 2), "elapsed_s": act.get("elapsed_time"),
            "moving_s": act.get("moving_time"), "elev_m": act.get("total_elevation_gain"), "elev_high": act.get("elev_high")}


def highest_point(token, aid):
    """Where on ride `aid` the altitude peaks: (lat, lon) or None. One streams call, only for the record ride."""
    try:
        st = api(token, f"/activities/{aid}/streams", keys="altitude,latlng", key_by_type="true")
        alt, ll = st["altitude"]["data"], st["latlng"]["data"]
        i = max(range(min(len(alt), len(ll))), key=lambda k: alt[k])
        return round(ll[i][0], 5), round(ll[i][1], 5)
    except Exception as e:  # a nicety; never fail the run for it
        log("highest-point lookup failed:", e)
        return None


def compute_records(rides, token, old):
    """Record days (grouped by the riders' local date) and the highest point reached."""
    days = defaultdict(lambda: {"km": 0.0, "moving_s": 0, "elev_m": 0.0, "from": None, "to": None})
    for r in rides.values():
        d = days[(r.get("start_local") or r["start"])[:10]]
        d["km"] += r["km"]; d["moving_s"] += r.get("moving_s") or 0; d["elev_m"] += r.get("elev_m") or 0
        t0 = parse_time(r["start"]); t1 = t0 + timedelta(seconds=r.get("elapsed_s") or 0)
        d["from"] = min(d["from"], iso(t0)) if d["from"] else iso(t0)
        d["to"] = max(d["to"], iso(t1)) if d["to"] else iso(t1)
    if not days:
        return {}

    def best(key):
        date, d = max(days.items(), key=lambda kv: kv[1][key])
        return date, d

    rec = {}
    date, d = best("km");       rec["furthest"] = {"date": date, "km": round(d["km"], 1), "from": d["from"], "to": d["to"]}
    date, d = best("moving_s")
    if d["moving_s"]:
        rec["longest"] = {"date": date, "moving_s": int(d["moving_s"]), "km": round(d["km"], 1), "from": d["from"], "to": d["to"]}
    date, d = best("elev_m")
    if d["elev_m"]:
        rec["climb"] = {"date": date, "m": round(d["elev_m"]), "km": round(d["km"], 1), "from": d["from"], "to": d["to"]}

    high = [(r["elev_high"], aid) for aid, r in rides.items() if r.get("elev_high") is not None]
    if high:
        m, aid = max(high)
        r = rides[aid]
        t0 = parse_time(r["start"])
        h = {"ride": aid, "date": (r.get("start_local") or r["start"])[:10], "m": round(m),
             "from": iso(t0), "to": iso(t0 + timedelta(seconds=r.get("elapsed_s") or 0))}
        prev = (old.get("records") or {}).get("highest") or {}
        if prev.get("ride") == aid and prev.get("lat") is not None:
            h.update({k: prev[k] for k in ("lat", "lon", "place") if k in prev})  # already located; don't ask again
        else:
            ll = highest_point(token, aid)
            if ll:
                h["lat"], h["lon"] = ll
                if not os.environ.get("NO_GEOCODE"):
                    h["place"] = reverse_geocode(*ll)
        rec["highest"] = h
    return rec


def main():
    cfg = json.loads(CONFIG.read_text())
    token = access_token()
    rides = json.loads(RIDES.read_text()) if RIDES.exists() else {}
    track = json.loads(TRACK.read_text()) if TRACK.exists() else {"points": []}
    points = {p["t"]: p for p in track.get("points", [])}
    old = json.loads(SUMMARY.read_text()) if SUMMARY.exists() else {}

    # Always list from the trip start (a few cheap calls): rides uploaded late or back-dated are picked up too.
    after = int(datetime.fromisoformat(cfg["start_date"]).replace(tzinfo=timezone.utc).timestamp()) - 86400
    page, new, changed = 1, 0, 0
    while True:
        batch = api(token, "/athlete/activities", after=after, per_page=100, page=page)
        if not batch:
            break
        for act in batch:
            aid = str(act["id"])
            if act.get("type") not in RIDE_TYPES:
                continue
            meta = ride_meta(act)
            if aid in rides:  # keep stored facts in step with Strava (edits, and fields added to this script later)
                merged = {**rides[aid], **meta}
                if merged != rides[aid]:
                    rides[aid] = merged; changed += 1
                continue
            detail = api(token, f"/activities/{aid}", include_all_efforts="false")
            pts = ride_points(act, detail)
            for p in pts:
                points[p["t"]] = p
            rides[aid] = {**meta, "points": len(pts)}
            new += 1
            log(f"+ {act['start_date'][:10]} {act.get('name')} {meta['km']} km ({len(pts)} pts)")
        page += 1

    if new == 0 and changed == 0 and old.get("records") and TRACK.exists():
        log(f"{len(rides)} rides, nothing new")  # leave the files untouched so the workflow makes no empty commits
        return 0

    pts = sorted(points.values(), key=lambda p: p["t"])
    if new:
        TRACK.write_text(json.dumps({"points": pts}, separators=(",", ":")) + "\n")
    RIDES.write_text(json.dumps(rides, indent=1, ensure_ascii=False) + "\n")

    now = datetime.now(timezone.utc)
    riding_days = len({(r.get("start_local") or r["start"])[:10] for r in rides.values()})
    summary = {"updated": iso(now), "source": "strava", "rides": len(rides), "riding_days": riding_days,
               "total_km": round(sum(r["km"] for r in rides.values()), 1),
               "elev_m": round(sum(r.get("elev_m") or 0 for r in rides.values())),
               "moving_h": round(sum(r.get("moving_s") or 0 for r in rides.values()) / 3600, 1)}
    if pts:
        last = pts[-1]
        summary["last"] = last
        last_ride = max(rides.values(), key=lambda r: r["start"]) if rides else None
        if last_ride:
            summary["last_ride"] = {"name": last_ride["name"], "start": last_ride["start"], "km": last_ride["km"]}
        if old.get("last", {}).get("t") == last["t"] and old.get("place"):
            summary["place"] = old["place"]
        elif not os.environ.get("NO_GEOCODE"):
            summary["place"] = reverse_geocode(last["lat"], last["lon"])
    summary["records"] = compute_records(rides, token, old)
    SUMMARY.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    log(f"{len(rides)} rides ({new} new, {changed} updated), {len(pts)} points, {summary['total_km']} km")
    return 0


if __name__ == "__main__":
    sys.exit(main())
