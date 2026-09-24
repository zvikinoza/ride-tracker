#!/usr/bin/env python3
"""Generate a plausible demo track along the real route (St. Gilgen -> Tbilisi, flight to Tashkent,
-> Khorog) so the site has something to show before the MapShare feed is connected.
Writes data/demo-track.json and data/demo-summary.json."""
import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
cfg = json.loads((ROOT / "config.json").read_text())
random.seed(7)

FLIGHT = "FLIGHT"
ROUTE = [  # (lat, lon, name) — FLIGHT marks a hop by plane between the neighbours
    (47.7676, 13.3666, "St. Gilgen"), (47.7119, 13.6212, "Bad Ischl"), (47.5622, 14.1000, "Liezen"),
    (47.0707, 15.4395, "Graz"), (46.5547, 15.6459, "Maribor"), (45.8150, 15.9819, "Zagreb"),
    (45.1600, 18.0200, "Slavonski Brod"), (44.7866, 20.4489, "Belgrade"), (43.3209, 21.8958, "Niš"),
    (42.6977, 23.3219, "Sofia"), (42.1354, 24.7453, "Plovdiv"), (41.6771, 26.5557, "Edirne"),
    (41.0082, 28.9784, "Istanbul"), (40.7800, 30.4000, "Sakarya"), (40.7356, 31.6061, "Bolu"),
    (39.9334, 32.8597, "Ankara"), (40.5489, 34.9533, "Çorum"), (41.2867, 36.3300, "Samsun"),
    (40.9839, 37.8764, "Ordu"), (41.0027, 39.7168, "Trabzon"), (41.3906, 41.4178, "Hopa"),
    (41.6168, 41.6367, "Batumi"), (42.2679, 42.6946, "Kutaisi"), (41.9844, 44.1110, "Gori"),
    (41.7151, 44.8271, "Tbilisi"),
    FLIGHT,
    (41.2995, 69.2401, "Tashkent"), (40.1158, 67.8422, "Jizzakh"), (39.6270, 66.9750, "Samarkand"),
    (38.2667, 67.9000, "Denau"), (38.5598, 68.7870, "Dushanbe"), (37.9147, 69.7846, "Kulob"),
    (38.4562, 70.7973, "Kalai-Khumb"), (37.4897, 71.5546, "Khorog"),
]


def hav(a, b):
    r = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    s = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(s))


# Build the sequence of fixes: ("ride", lat, lon) every ~3 km with gentle wobble, or ("flight", lat, lon).
seq = []
for a, b in zip(ROUTE, ROUTE[1:]):
    if a == FLIGHT:
        continue
    if b == FLIGHT:
        seq.append(("ride", a[0], a[1]))
        seq.append(("flight", ROUTE[ROUTE.index(b) + 1][0], ROUTE[ROUTE.index(b) + 1][1]))
        continue
    n = max(2, int(hav(a, b) / 3))
    amp, phase = random.uniform(0.01, 0.03), random.uniform(0, math.pi)
    for i in range(n):
        f = i / n
        wob = math.sin(f * math.pi * 3 + phase) * amp * math.sin(f * math.pi)
        seq.append(("ride", a[0] + (b[0] - a[0]) * f + wob, a[1] + (b[1] - a[1]) * f + wob * 0.6))
seq.append(("ride", ROUTE[-1][0], ROUTE[-1][1]))

# Schedule: ride 08:00-16:30 local (~UTC+3), rest every 6th day, flight = next morning + 4 h in the air.
start = datetime.fromisoformat(cfg["start_date"]).replace(tzinfo=timezone.utc)
rides = sum(1 for s in seq if s[0] == "ride")
days_avail = max(10, (datetime.now(timezone.utc) - start).days - 1)
ride_days = max(5, int(days_avail * 5 / 6))
per_day = math.ceil(rides / ride_days)

points = []
day, n_today, i = 0, 0, 0
t = start + timedelta(hours=5)
while i < len(seq):
    kind, lat, lon = seq[i]
    if kind == "flight":
        day += 1
        t = start + timedelta(days=day, hours=7)
        p = points[-1]
        points.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "lat": p["lat"], "lon": p["lon"], "alt": p.get("alt", 400)})  # at the airport
        t += timedelta(hours=4)
        points.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "lat": lat, "lon": lon, "alt": 450})
        day += 1
        t = start + timedelta(days=day, hours=5)
        n_today = 0
        i += 1
        continue
    if n_today >= per_day:
        day += 1
        n_today = 0
        if day % 6 == 0:  # rest day: two fixes in town
            p = points[-1]
            for k in range(2):
                tt = start + timedelta(days=day, hours=8 + 3 * k)
                points.append({"t": tt.strftime("%Y-%m-%dT%H:%M:%SZ"), "lat": round(p["lat"] + random.uniform(-2e-4, 2e-4), 6),
                               "lon": round(p["lon"] + random.uniform(-2e-4, 2e-4), 6)})
            day += 1
        t = start + timedelta(days=day, hours=random.uniform(4.5, 5.5))
    points.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "lat": round(lat, 6), "lon": round(lon, 6), "alt": random.randint(20, 2800)})
    t += timedelta(minutes=random.uniform(9, 13))
    n_today += 1
    i += 1

# Shift everything so the newest fix is ~1.5 h old.
now = datetime.now(timezone.utc)
last = datetime.strptime(points[-1]["t"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
shift = (now - timedelta(hours=1.5)) - last
for p in points:
    d = datetime.strptime(p["t"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) + shift
    p["t"] = d.strftime("%Y-%m-%dT%H:%M:%SZ")

(ROOT / "data" / "demo-track.json").write_text(json.dumps({"points": points}, separators=(",", ":")) + "\n")
(ROOT / "data" / "demo-summary.json").write_text(json.dumps({
    "updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "fixes": len(points), "last": points[-1], "place": "Khorog, Tajikistan"
}, indent=2) + "\n")
print(f"{len(points)} demo points, first {points[0]['t']}, last {points[-1]['t']}")
