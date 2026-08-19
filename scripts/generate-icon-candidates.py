#!/usr/bin/env python3
"""Generate Omni app-icon candidates.

The aperture-ring mark is reconstructed from the original artwork by iterative
Hough fitting of assets/omni-icon.png, which resolved it to six curves:

    concentric outer ring   centre 511.5,511.5   R=172   100% arc coverage
    concentric inner ring   centre 511.5,511.5   R=96    100% arc coverage
    four blade circles      offset ~38-46        R=131..137

Each blade circle is internally tangent to the outer ring and externally
tangent to the inner ring, which makes the construction exact:

    blade_r      = (R_out + R_in) / 2
    blade_offset = (R_out - R_in) / 2

The original's blade phases (17.5, 123.7, 200.2, 304.4 degrees) are irregular
because the source artwork was painted, not drawn. They are regularised to an
exact 90 degree spacing here.

Stroke weight is deliberately increased. The original is 6.2px on a 346px mark,
1.8% of the mark diameter, which is sub-pixel at 32px; that is why the original
collapses into a featureless grey-green donut in the Dock and Finder.

Output is always 8-bit RGBA (PNG colour type 6). Tauri's generate_context!
macro rejects any other colour type at build time.
"""

from __future__ import annotations

import colorsys
import math
import os
import struct
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "assets" / "icon-candidates"

SIZE = 1024
TILE = 824.0          # Apple macOS app-icon template: 824x824 inside 1024x1024
SQUIRCLE_N = 5.0      # superellipse exponent approximating the macOS squircle

# Mark geometry.
#
# MARK_OUTER and INNER_OVER_OUTER are tuned for small-size legibility rather
# than copied from the original. The original's 0.558 inner/outer ratio leaves a
# 76px annulus crowded with six curves, which resolves to grey speckle at 32px.
# Opening the pupil to 0.66 narrows the annulus so the two rings very nearly
# fill it, and the result downscales to a solid ring with a crisp pupil while
# the blades still cut visible notches at 128px and above.
MARK_OUTER = 270.0                            # 540px diameter = 66% of the tile
INNER_OVER_OUTER = 0.66
BLADES = 4
BLADE_PHASE = 20.0                            # matches the original's orientation
STROKE = float(os.environ.get("OMNI_ICON_STROKE", 36.0))


def hsv(h_deg: float, s: float, v: float) -> tuple[float, float, float]:
    return colorsys.hsv_to_rgb(h_deg / 360.0, s, v)


def hex_rgb(code: str) -> tuple[float, float, float]:
    code = code.lstrip("#")
    return tuple(int(code[i : i + 2], 16) / 255.0 for i in (0, 2, 4))


# Brand accents. Hue sweep measured off the original glow halo: 192 deg
# (aqua) at the top-left of the mark running to 152 deg (spring green) at the
# bottom-right. Those two ends are reproduced without the bloom.
AQUA = hsv(186, 0.66, 0.94)
GREEN = hsv(152, 0.78, 0.88)
MID = hsv(168, 0.74, 0.90)

_yy, _xx = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
CX = CY = (SIZE - 1) / 2.0
PX = _xx - CX
PY = _yy - CY


def squircle_alpha() -> np.ndarray:
    """Antialiased superellipse covering the macOS icon template area."""
    a = TILE / 2.0
    g = (np.abs(PX / a) ** SQUIRCLE_N + np.abs(PY / a) ** SQUIRCLE_N) ** (1.0 / SQUIRCLE_N)
    return np.clip(0.5 - (g - 1.0) * a, 0.0, 1.0).astype(np.float32)


def squircle_field() -> np.ndarray:
    a = TILE / 2.0
    g = (np.abs(PX / a) ** SQUIRCLE_N + np.abs(PY / a) ** SQUIRCLE_N) ** (1.0 / SQUIRCLE_N)
    return ((g - 1.0) * a).astype(np.float32)  # approx signed px distance to edge


def _ring(cx_off: float, cy_off: float, radius: float, half: float) -> np.ndarray:
    d = np.abs(np.hypot(PX - cx_off, PY - cy_off) - radius)
    return np.clip(half + 0.5 - d, 0.0, 1.0)


def mark_alpha(
    stroke: float = STROKE,
    blade_stroke: float | None = None,
    outer: float = MARK_OUTER,
    ratio: float = INNER_OVER_OUTER,
    blades: int = BLADES,
    inner_ring: bool = True,
) -> np.ndarray:
    """The aperture mark: two concentric rings plus four tangent blade circles.

    Every curve is an analytically antialiased distance-field stroke, so the
    geometry is exact at any output size and needs no supersampling.

    ``blade_stroke`` lets the blades run lighter than the rings. That is what
    makes the mark degrade gracefully: at 32px the blades fade to a wash while
    the rings hold the aperture silhouette, instead of every curve fighting for
    the same pixel.
    """
    if blade_stroke is None:
        blade_stroke = stroke
    inner = outer * ratio
    b_r = (outer + inner) / 2.0
    b_d = (outer - inner) / 2.0
    acc = _ring(0.0, 0.0, outer, stroke / 2.0)
    if inner_ring:
        acc = np.maximum(acc, _ring(0.0, 0.0, inner, stroke / 2.0))
    for k in range(blades):
        ang = math.radians(BLADE_PHASE + k * (360.0 / blades))
        acc = np.maximum(
            acc,
            _ring(b_d * math.cos(ang), b_d * math.sin(ang), b_r, blade_stroke / 2.0),
        )
    return acc


def axis_t() -> np.ndarray:
    """0 at the top-left of the mark, 1 at the bottom-right.

    This is the axis of the original artwork's hue sweep, measured off its glow
    halo: 192 degrees (aqua) at the top-left running to 152 degrees (spring
    green) at the bottom-right.
    """
    proj = (PX + PY) / (2.0 * MARK_OUTER)
    return np.clip(proj * 0.5 + 0.5, 0.0, 1.0).astype(np.float32)


def lerp_rgb(c0, c1, t: np.ndarray) -> np.ndarray:
    out = np.empty((SIZE, SIZE, 3), dtype=np.float32)
    for i in range(3):
        out[..., i] = c0[i] + (c1[i] - c0[i]) * t
    return out


def solid(colour) -> np.ndarray:
    out = np.empty((SIZE, SIZE, 3), dtype=np.float32)
    for i in range(3):
        out[..., i] = colour[i]
    return out


def add_rim(ground: np.ndarray, strength: float = 0.22, width: float = 3.5) -> np.ndarray:
    """Whisper-quiet inner edge highlight.

    A near-black tile has no silhouette against a dark Dock, a dark sidebar or a
    notification: without this you see a green ring floating in nothing. The
    uniform floor keeps the whole perimeter legible, and the top-weighted
    component reads as a single overhead light rather than a glow.
    """
    f = squircle_field()
    band = np.clip(1.0 - np.abs(f + width / 2.0) / (width / 2.0), 0.0, 1.0)
    top = np.clip(1.0 - (_yy / (SIZE - 1.0)) * 1.35, 0.0, 1.0) ** 1.5
    vertical = 0.34 + 0.66 * top
    amount = (band * vertical * strength).astype(np.float32)[..., None]
    return ground + (1.0 - ground) * amount


def compose(ground: np.ndarray, mark_rgb: np.ndarray, m_alpha: np.ndarray) -> Image.Image:
    rgb = ground * (1.0 - m_alpha[..., None]) + mark_rgb * m_alpha[..., None]
    alpha = squircle_alpha()
    arr = np.concatenate([np.clip(rgb, 0.0, 1.0), alpha[..., None]], axis=2)
    return Image.fromarray(np.rint(arr * 255.0).astype(np.uint8)).convert("RGBA")


# ---------------------------------------------------------------- candidates

def candidate_1() -> Image.Image:
    """Flat single-colour ground; the mark carries all the interest.

    Dead-flat deep ink. The only variation in the whole icon is the aqua ->
    green sweep along the mark itself, which is the one piece of the original
    artwork worth keeping.
    """
    ground = add_rim(solid(hex_rgb("#0D1211")))
    return compose(ground, lerp_rgb(AQUA, GREEN, axis_t()), mark_alpha())


def candidate_2() -> Image.Image:
    """Subtle vertical gradient, no streaks; single flat accent mark."""
    t = (_yy / (SIZE - 1.0)).astype(np.float32) ** 0.85
    ground = add_rim(lerp_rgb(hex_rgb("#18231F"), hex_rgb("#060A09"), t))
    return compose(ground, solid(MID), mark_alpha())


def candidate_3() -> Image.Image:
    """Deep matte ground with one soft light source, top-left.

    A single broad falloff instead of several crossing streaks. The mark's own
    gradient is oriented to agree with the light, so the icon reads as one lit
    object rather than a collage.
    """
    lx, ly = -0.42 * SIZE, -0.46 * SIZE
    dist = np.hypot(PX - lx, PY - ly) / (SIZE * 1.18)
    fall = np.clip(1.0 - dist, 0.0, 1.0) ** 2.1
    ground = add_rim(lerp_rgb(hex_rgb("#090C0C"), hex_rgb("#243330"), fall))
    mark = lerp_rgb(AQUA, GREEN, np.clip(axis_t() * 1.15 - 0.07, 0.0, 1.0))
    return compose(ground, mark, mark_alpha())


def candidate_4() -> Image.Image:
    """Inverted: bone ground, deep teal mark.

    Highest contrast of the set at small sizes and the only one guaranteed to
    hold a silhouette on both light and dark desktops. Hue is retained in the
    mark so it still reads as the same brand.
    """
    t = (_yy / (SIZE - 1.0)).astype(np.float32)
    ground = lerp_rgb(hex_rgb("#F2F4F1"), hex_rgb("#DFE5E1"), t)
    # A light tile needs the opposite of add_rim: a faint inner edge shade so it
    # does not bleed into a light desktop.
    band = np.clip(1.0 - np.abs(squircle_field() + 2.0) / 2.0, 0.0, 1.0)[..., None]
    ground = ground * (1.0 - band * 0.10)
    mark = lerp_rgb(hex_rgb("#0C5346"), hex_rgb("#0A3F2C"), axis_t())
    return compose(ground, mark, mark_alpha())


CANDIDATES = {
    1: ("flat single-colour ground, gradient mark", candidate_1),
    2: ("subtle vertical gradient, flat mark", candidate_2),
    3: ("deep matte ground, single soft light", candidate_3),
    4: ("inverted: bone ground, deep teal mark", candidate_4),
}


def verify_rgba(path: Path) -> tuple[int, int, int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} is not a PNG")
    w, h, bitdepth, colourtype = struct.unpack(">IIBB", data[16:26])
    if (bitdepth, colourtype) != (8, 6):
        raise SystemExit(
            f"{path} is bitdepth={bitdepth} colourtype={colourtype}; "
            "Tauri generate_context! requires 8-bit RGBA (colour type 6)"
        )
    return w, h, bitdepth, colourtype


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for num, (label, fn) in CANDIDATES.items():
        img = fn().convert("RGBA")
        base = OUT_DIR / f"candidate-{num}.png"
        img.save(base)
        for px in (32, 16):
            small = img.resize((px, px), Image.LANCZOS).convert("RGBA")
            name = f"candidate-{num}-{px}px.png"
            small.save(OUT_DIR / name)
            verify_rgba(OUT_DIR / name)
        w, h, bd, ct = verify_rgba(base)
        print(f"candidate-{num}.png  {w}x{h} bitdepth={bd} colourtype={ct}  {label}")


if __name__ == "__main__":
    main()
