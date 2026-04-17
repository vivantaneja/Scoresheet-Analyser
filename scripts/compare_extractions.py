#!/usr/bin/env python3
"""
Compare two match JSON files (e.g. two extraction runs) and print simple field-level stats.

Usage::

    python scripts/compare_extractions.py baseline.json candidate.json

Exit code 0 always; meant for human review and CI logs.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _load(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))


def _scalar_diff(
    a: Any, b: Any, path: str, out: List[Tuple[str, Any, Any]]
) -> None:
    if type(a) != type(b) and not (
        isinstance(a, (int, float)) and isinstance(b, (int, float))
    ):
        out.append((path, a, b))
        return
    if isinstance(a, dict):
        keys = set(a.keys()) | set(b.keys())
        for k in sorted(keys):
            _scalar_diff(a.get(k), b.get(k), f"{path}.{k}" if path else k, out)
        return
    if isinstance(a, list):
        if len(a) != len(b):
            out.append((path + "[len]", len(a), len(b)))
        n = min(len(a), len(b))
        for i in range(n):
            _scalar_diff(a[i], b[i], f"{path}[{i}]", out)
        return
    if a != b:
        out.append((path, a, b))


def main() -> int:
    ap = argparse.ArgumentParser(description="Compare two extraction JSON files.")
    ap.add_argument("baseline", type=Path)
    ap.add_argument("candidate", type=Path)
    args = ap.parse_args()

    base = _load(args.baseline)
    cand = _load(args.candidate)

    diffs: List[Tuple[str, Any, Any]] = []
    _scalar_diff(base, cand, "", diffs)

    print(f"Baseline: {args.baseline}")
    print(f"Candidate: {args.candidate}")
    print(f"Total differing leaves / length mismatches: {len(diffs)}")
    for path, av, bv in diffs[:200]:
        print(f"  {path}: {av!r} -> {bv!r}")
    if len(diffs) > 200:
        print(f"  ... and {len(diffs) - 200} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
