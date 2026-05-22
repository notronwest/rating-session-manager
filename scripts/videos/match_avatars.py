#!/usr/bin/env python3
"""
Match pb.vision avatar thumbnails to known-tagged references using CLIP
image embeddings.

Used by `POST /api/sessions/:id/tagging/suggest`: after a coach manually
tags Game 1 of a session, this script suggests tagging for Games 2/3 by
embedding all 4 reference (known-name) avatars from Game 1 plus all 4
candidate avatars from the untagged game, then matching them via cosine
similarity + Hungarian assignment. Within a single recording session the
players wear identical clothes, so whole-body CLIP features give very
strong signal.

I/O is JSON over stdin/stdout so the Node/TS layer can call us via
child_process without any binding glue.

Input (stdin):
{
  "references": [
    {"player_id": "<uuid>", "name": "Ron West", "url": "https://.../player1-0.jpg"},
    ...
  ],
  "candidates": [
    {"slot": 0, "url": "https://.../player3-0.jpg"},
    ...
  ]
}

Output (stdout):
{
  "matches": [
    {
      "slot": 0,
      "player_id": "<uuid>",
      "player_name": "Ron West",
      "confidence": 0.92,
      "margin": 0.17
    },
    ...
  ]
}

`confidence` is the cosine similarity in [0, 1].
`margin` is best - second-best for the same slot — small margins mean
the model is unsure and the frontend should highlight the suggestion as
low-confidence so the coach double-checks before saving.

First run downloads the CLIP ViT-B/32 weights (~150 MB) into the
HuggingFace / open_clip cache; subsequent runs are <2 s on the Mac Mini
CPU for 8 thumbnails.
"""

from __future__ import annotations

import io
import json
import os
import sys
from typing import Any
from urllib.request import Request, urlopen

import numpy as np
import open_clip
import torch
from PIL import Image
from scipy.optimize import linear_sum_assignment


# Single-process model cache. Loaded lazily so a JSON parse error or empty
# input doesn't pay the ~1 s model-load cost.
_MODEL = None
_PREPROCESS = None


def _load_model():
    global _MODEL, _PREPROCESS
    if _MODEL is None:
        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="openai"
        )
        model.eval()
        _MODEL = model
        _PREPROCESS = preprocess
    return _MODEL, _PREPROCESS


def _fetch_image(url: str) -> Image.Image:
    req = Request(url, headers={"User-Agent": "wmpc-tagging-suggester/1.0"})
    with urlopen(req, timeout=15) as resp:
        data = resp.read()
    return Image.open(io.BytesIO(data)).convert("RGB")


def _embed(urls: list[str]) -> np.ndarray:
    """Return an L2-normalised [N, D] embedding matrix for the given URLs."""
    model, preprocess = _load_model()
    tensors = [preprocess(_fetch_image(u)) for u in urls]
    batch = torch.stack(tensors, dim=0)
    with torch.no_grad():
        emb = model.encode_image(batch)
        emb = emb / emb.norm(dim=-1, keepdim=True)
    return emb.cpu().numpy()


def main() -> int:
    try:
        inp: dict[str, Any] = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        json.dump({"error": f"invalid json on stdin: {e}"}, sys.stdout)
        return 1

    refs = inp.get("references") or []
    cands = inp.get("candidates") or []
    if not refs or not cands:
        json.dump({"matches": []}, sys.stdout)
        return 0

    try:
        ref_embs = _embed([r["url"] for r in refs])
        cand_embs = _embed([c["url"] for c in cands])
    except Exception as e:  # noqa: BLE001 — surface any fetch/decode/model err
        json.dump({"error": f"embedding failed: {e!r}"}, sys.stdout)
        return 1

    # Cosine similarity is just the dot product after L2-normalising.
    sim = cand_embs @ ref_embs.T  # shape [C, R]

    # Hungarian assignment over -sim → maximise total similarity while
    # forcing one-to-one between candidates and references. Within a
    # single game no player appears twice, so this gives the optimal
    # joint assignment instead of greedy per-slot.
    row_ind, col_ind = linear_sum_assignment(-sim)

    matches: list[dict[str, Any]] = []
    for r, c in zip(row_ind, col_ind):
        slot = cands[r]["slot"]
        ref = refs[c]
        conf = float(sim[r, c])
        # Second-best for the same candidate slot (margin = best - 2nd).
        row = sim[r].copy()
        row[c] = -np.inf
        second_conf = float(row.max()) if row.size > 1 else conf
        matches.append(
            {
                "slot": slot,
                "player_id": ref["player_id"],
                "player_name": ref.get("name"),
                "confidence": conf,
                "margin": conf - second_conf,
            }
        )

    matches.sort(key=lambda m: m["slot"])
    json.dump({"matches": matches}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
