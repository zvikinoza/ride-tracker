#!/usr/bin/env python3
"""Which countries the route has entered, and where.

Works from the stored track alone (no Strava access needed). Each ride's start and end are looked up once
and cached in rides.json; when a ride starts in one country and ends in another, the border is located by
bisecting along the ride (about eight lookups). Run directly to (re)build data/summary.json's `countries`:
    python scripts/countries.py
"""
import bisect
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_track import UA, iso, log, parse_time  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
_cache = {}


def country_at(lat, lon):
    """{'code': 'TR', 'name': 'Turkey'} for a position, or None (open water, lookup failed)."""
    key = (round(lat, 3), round(lon, 3))
    if key in _cache:
        return _cache[key]
    out = None
    try:
        q = urllib.parse.urlencode({"lat": lat, "lon": lon, "lang": "en"})
        req = urllib.request.Request(f"https://photon.komoot.io/reverse?{q}", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            feats = json.load(r).get("features") or []
        if feats and feats[0]["properties"].get("countrycode"):
            p = feats[0]["properties"]
            out = {"code": p["countrycode"].upper(), "name": p.get("country") or p["countrycode"].upper()}
    except Exception as e:
        log("photon failed:", e)
    if out is None:
        try:
            q = urllib.parse.urlencode({"format": "jsonv2", "lat": lat, "lon": lon, "zoom": 3, "accept-language": "en"})
            req = urllib.request.Request(f"https://nominatim.openstreetmap.org/reverse?{q}", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                a = json.load(r).get("address") or {}
            if a.get("country_code"):
                out = {"code": a["country_code"].upper(), "name": a.get("country") or a["country_code"].upper()}
        except Exception as e:
            log("nominatim failed:", e)
    time.sleep(1.0)  # be a polite guest on the free geocoders
    _cache[key] = out
    return out


def ride_slice(ride, pts, times):
    t0 = parse_time(ride["start"])
    lo = bisect.bisect_left(times, iso(t0))
    hi = bisect.bisect_right(times, iso(t0 + timedelta(seconds=ride.get("elapsed_s") or 0)))
    return pts[lo:hi]


def first_known(seq):
    for p in seq[:6]:
        c = country_at(p["lat"], p["lon"])
        if c:
            return c
    return None


def annotate(rides, pts):
    """Add c_start / c_end / crossings to rides that lack them. Returns how many rides were updated."""
    times = [p["t"] for p in pts]
    done = 0
    for aid, ride in sorted(rides.items(), key=lambda kv: kv[1]["start"]):
        if "c_start" in ride:
            continue
        seg = ride_slice(ride, pts, times)
        if not seg:
            ride["c_start"] = ride["c_end"] = None; ride["crossings"] = []
            done += 1
            continue
        start, end = first_known(seg), first_known(seg[::-1])
        crossings = []
        if start and end and start["code"] != end["code"]:
            pos, cur = 0, start
            for _ in range(4):  # a ride can cross more than one border
                if cur["code"] == end["code"]:
                    break
                lo, hi, hi_c = pos, len(seg) - 1, end
                while hi - lo > 1:
                    mid = (lo + hi) // 2
                    c = country_at(seg[mid]["lat"], seg[mid]["lon"])
                    if c is None or c["code"] == cur["code"]:
                        lo = mid
                    else:
                        hi, hi_c = mid, c
                crossings.append({**hi_c, "t": seg[hi]["t"], "lat": seg[hi]["lat"], "lon": seg[hi]["lon"]})
                pos, cur = hi, hi_c
        ride["c_start"], ride["c_end"], ride["crossings"] = start, end, crossings
        done += 1
        log(f"  {ride['start'][:10]} {(start or {}).get('code')} -> {(end or {}).get('code')}" + (f" via {[c['code'] for c in crossings]}" if crossings else ""))
    return done


def sequence(rides, pts):
    """Countries in the order first entered: [{code, name, date, t, lat, lon}]."""
    times = [p["t"] for p in pts]
    seen, out, cur = set(), [], None

    def enter(c, point, date):
        nonlocal cur
        cur = c["code"]
        if c["code"] not in seen:
            seen.add(c["code"])
            out.append({"code": c["code"], "name": c["name"], "date": date, "t": point["t"], "lat": point["lat"], "lon": point["lon"]})

    for aid, ride in sorted(rides.items(), key=lambda kv: kv[1]["start"]):
        seg = ride_slice(ride, pts, times)
        if not seg or not ride.get("c_start"):
            continue
        date = (ride.get("start_local") or ride["start"])[:10]
        if ride["c_start"]["code"] != cur:
            enter(ride["c_start"], seg[0], date)  # arrived between rides (flight, bus, unrecorded stretch)
        for c in ride.get("crossings") or []:
            enter(c, c, date)
        if ride.get("c_end"):
            cur = ride["c_end"]["code"]
    return out


if __name__ == "__main__":
    rides = json.loads((ROOT / "data" / "rides.json").read_text())
    pts = sorted(json.loads((ROOT / "data" / "track.json").read_text())["points"], key=lambda p: p["t"])
    n = annotate(rides, pts)
    (ROOT / "data" / "rides.json").write_text(json.dumps(rides, indent=1, ensure_ascii=False) + "\n")
    sp = ROOT / "data" / "summary.json"
    summary = json.loads(sp.read_text())
    summary["countries"] = sequence(rides, pts)
    sp.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    log(f"{n} rides looked up; {len(summary['countries'])} countries:", ", ".join(c["name"] for c in summary["countries"]))
