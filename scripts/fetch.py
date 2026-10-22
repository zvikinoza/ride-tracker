#!/usr/bin/env python3
"""Entry point for the workflow: picks the data source from config.json ("source": "strava" | "mapshare")."""
import json
import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
cfg = json.loads((ROOT / "config.json").read_text())
source = cfg.get("source", "mapshare")
script = {"strava": "fetch_strava.py", "mapshare": "fetch_track.py"}[source]
sys.argv = [script]
runpy.run_path(str(ROOT / "scripts" / script), run_name="__main__")
