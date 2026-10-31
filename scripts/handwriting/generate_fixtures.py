"""Synthetic regression images, NOT real student handwriting or an accuracy benchmark.
Run with backend/.venv/bin/python scripts/handwriting/generate_fixtures.py on macOS.
Fonts remain on the host; only raster images are distributed.
"""
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend/public/handwriting"
OUT.mkdir(parents=True, exist_ok=True)
FONT = "/System/Library/Fonts/Supplemental/Comic Sans MS.ttf"
CN_FONT = "/System/Library/Fonts/STHeiti Medium.ttc"
manifest = []


def make(name, tags, lines, draw_fn=None):
    img = Image.new("RGB", (900, 420), "#fffefa")
    d = ImageDraw.Draw(img)
    for y in range(80, 420, 90):
        d.line((20, y, 880, y), fill="#e5e9ed", width=1)
    for i, line in enumerate(lines):
        if line:
            d.text((50, 25 + 105 * i), line, fill="#233651", font=ImageFont.truetype(CN_FONT if name == "mixed" else FONT, 40))
    if draw_fn:
        draw_fn(d)
    path = OUT / f"{name}.png"
    img.save(path)
    manifest.append({"id": name, "image": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                     "tags": tags, "origin": "synthetic_font_and_pen_strokes", "expected": []})


def text(d, at, value, size=40):
    d.text(at, value, fill="#233651", font=ImageFont.truetype(FONT, size))


def fraction(d):
    text(d, (50, 95), "y =")
    text(d, (180, 35), "x + 1")
    d.line((170, 105, 315, 107), fill="#233651", width=3)
    text(d, (200, 115), "2x")


def exponent(d):
    text(d, (50, 60), "y = x")
    text(d, (160, 40), "2", 26)
    text(d, (195, 60), "+ x")
    text(d, (275, 40), "-1", 26)
    text(d, (50, 165), "y' = 2x - x")
    text(d, (285, 145), "-2", 26)


def correction(d):
    text(d, (50, 35), "y' = 3x")
    text(d, (200, 15), "2", 26)
    d.line([(135, 52), (250, 79), (145, 83), (245, 48)], fill="#233651", width=3)
    text(d, (290, 35), "2x")
    text(d, (50, 140), "y = x")
    text(d, (160, 120), "2", 26)


make("fraction", ["fraction", "denominator"], [], fraction)
manifest[-1]["expected"] = [{"text": "y = (x + 1)/(2x)", "expressions": [r"y=\frac{x+1}{2x}"], "mark": "active"}]
make("exponent", ["exponent", "negative_exponent", "multiline"], [], exponent)
manifest[-1]["expected"] = [{"text": "y = x^2 + x^-1", "expressions": ["y=x^{2}+x^{-1}"], "mark": "active"}, {"text": "y' = 2x - x^-2", "expressions": ["y'=2x-x^{-2}"], "mark": "active"}]
make("negative", ["minus", "parentheses"], ["y = -(x - 2)", "y = -x + 2"])
manifest[-1]["expected"] = [{"text": "y = -(x - 2)", "expressions": ["y=-(x-2)"], "mark": "active"}, {"text": "y = -x + 2", "expressions": ["y=-x+2"], "mark": "active"}]
make("parentheses", ["parentheses", "multiline", "wrong_math_preserved"], ["y = (x + 1)(x - 1)", "y = x + 1 - x - 1", "y = 0"])
manifest[-1]["expected"] = [{"text": s, "expressions": [s.replace(' ', '')], "mark": "active"} for s in ["y = (x + 1)(x - 1)", "y = x + 1 - x - 1", "y = 0"]]
make("mixed", ["chinese", "english", "multiline"], ["先求 derivative", "令 u = 2x + 1", "所以 du/dx = 2"])
manifest[-1]["expected"] = [{"text": "先求 derivative", "expressions": [], "mark": "active"}, {"text": "令 u = 2x + 1", "expressions": ["u=2x+1"], "mark": "active"}, {"text": "所以 du/dx = 2", "expressions": [r"\frac{du}{dx}=2"], "mark": "active"}]
make("correction", ["crossed_out", "replacement", "order_ambiguity"], [], correction)
manifest[-1]["expected"] = [{"text": "3x^2", "expressions": ["3x^{2}"], "mark": "crossed_out"}, {"text": "y' = 2x", "expressions": ["y'=2x"], "mark": "active"}, {"text": "y = x^2", "expressions": ["y=x^{2}"], "mark": "active"}]
manifest[-1]["review_note"] = "原位置划掉 3x²，右侧改为 2x；允许按行分组，但不能把涂掉项作为有效结果。"
(ROOT / "docs/handwriting-evaluation/manifest.json").write_text(json.dumps({"version": 1, "cases": manifest}, ensure_ascii=False, indent=2) + "\n")
