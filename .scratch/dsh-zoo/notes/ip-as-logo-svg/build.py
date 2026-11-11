#!/usr/bin/env python3
"""Generate the six ip-as-logo candidates as hand-built SVG.

Rules kept from the skill:
- 1536 x 1536 square, one solid named background
- exactly two IP colours + one background colour
- one continuous silhouette, flat fills, no strokes/outlines/shadows
- upright, emerging from the lower-left corner, cropped by the viewBox
- no text, no borders, no scenery, no halo

All three directions share one face system: a colour mask over the muzzle that
carries the marks. That keeps the family consistent and keeps every mark inside
one of the two IP colours.
"""
import os

OUT = os.path.dirname(os.path.abspath(__file__))
S = 1536

SAGE = "#8FA58C"
MILK = "#F6EDE0"
CARAMEL = "#C68B54"

SLATE = "#7C8FA6"
ORANGE = "#E98A45"
CREAM = "#F7E9D2"

TEAL = "#6E9491"
COCOA = "#6B4A3A"
MUSTARD = "#D9A43F"


def ellipse(cx, cy, rx, ry, fill, angle=None):
    t = f' transform="rotate({angle} {cx} {cy})"' if angle else ""
    return f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{fill}"{t}/>'


def circle(cx, cy, r, fill):
    return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}"/>'


def rrect(x, y, w, h, r, fill, angle=None):
    t = f' transform="rotate({angle} {x + w / 2} {y + h / 2})"' if angle else ""
    return (
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" ry="{r}" '
        f'fill="{fill}"{t}/>'
    )


def stroke_path(d, color, width):
    return (
        f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" '
        'stroke-linecap="round" stroke-linejoin="round"/>'
    )


def head_path(cx, cy, hw, hh, color, ear_h=1.16, ear_tip=0.66, ear_inner=0.33, dip=0.84):
    """One continuous head silhouette with two round-tipped upright ears."""
    def P(x, y):
        return f"{cx + hw * x:.1f} {cy + hh * y:.1f}"

    d = "M " + P(0, 1)
    d += " C " + P(0.58, 1) + " " + P(0.94, 0.74) + " " + P(1.0, 0.16)
    d += " C " + P(1.0, -0.10) + " " + P(0.97, -0.30) + " " + P(0.92, -0.46)
    d += " C " + P(0.86, -ear_h + 0.34) + " " + P(ear_tip + 0.16, -ear_h + 0.16) + " " + P(ear_tip + 0.05, -ear_h)
    d += " Q " + P(ear_tip - 0.02, -ear_h - 0.07) + " " + P(ear_tip - 0.12, -ear_h + 0.02)
    d += " C " + P(ear_tip - 0.18, -ear_h + 0.14) + " " + P(ear_inner + 0.12, -dip - 0.14) + " " + P(ear_inner, -dip - 0.01)
    d += " Q " + P(ear_inner * 0.45, -dip + 0.05) + " " + P(0, -dip + 0.01)
    d += " Q " + P(-ear_inner * 0.45, -dip + 0.05) + " " + P(-ear_inner, -dip - 0.01)
    d += " C " + P(-ear_inner - 0.12, -dip - 0.14) + " " + P(-ear_tip + 0.18, -ear_h + 0.14) + " " + P(-ear_tip + 0.12, -ear_h + 0.02)
    d += " Q " + P(-ear_tip + 0.02, -ear_h - 0.07) + " " + P(-ear_tip - 0.05, -ear_h)
    d += " C " + P(-ear_tip - 0.16, -ear_h + 0.16) + " " + P(-0.86, -ear_h + 0.34) + " " + P(-0.92, -0.46)
    d += " C " + P(-0.97, -0.30) + " " + P(-1.0, -0.10) + " " + P(-1.0, 0.16)
    d += " C " + P(-0.94, 0.74) + " " + P(-0.58, 1) + " " + P(0, 1)
    d += " Z"
    return f'<path d="{d}" fill="{color}"/>'


def masked_face(cx, cy, hw, hh, mask_color, mark_color, mouth=True):
    """Eyes on the head, one soft muzzle patch below them, mouth inside it."""
    out = []
    for sx in (-1, 1):
        out.append(circle(cx + sx * 0.220 * hw, cy + 0.05 * hh, 0.070 * hw, mask_color))
    out.append(ellipse(cx, cy + 0.60 * hh, 0.40 * hw, 0.32 * hh, mask_color))
    if mouth:
        y = cy + 0.69 * hh
        w = 0.10 * hw
        out.append(
            stroke_path(
                f"M {cx - w} {y} Q {cx} {y + 0.07 * hh} {cx + w} {y}",
                mark_color,
                0.040 * hw,
            )
        )
    return "\n".join(out)


def svg(body, bg):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">
<rect width="{S}" height="{S}" fill="{bg}"/>
{body}
</svg>
'''


# ---------------------------------------------------------------- direction A
# round-eared corgi puppy / caramel head + milk mask / muted sage
def a1():
    b = []
    b.append(ellipse(820, 1580, 500, 410, CARAMEL))                       # body, cropped
    b.append(head_path(520, 850, 560, 395, CARAMEL, ear_h=1.10, ear_tip=0.68))
    b.append(masked_face(520, 850, 560, 395, MILK, CARAMEL))
    b.append(ellipse(660, 1440, 235, 215, MILK))                          # chest
    return svg("\n".join(b), SAGE)


def a2():
    b = []
    b.append(ellipse(1000, 1680, 540, 430, CARAMEL))
    b.append(head_path(560, 960, 600, 425, CARAMEL, ear_h=1.08, ear_tip=0.67))
    b.append(masked_face(560, 960, 600, 425, MILK, CARAMEL, mouth=False))
    return svg("\n".join(b), SAGE)


# ---------------------------------------------------------------- direction B
# sitting orange cat / orange head + cream mask / muted slate blue
def b1():
    b = []
    b.append(stroke_path("M 990 1420 C 1190 1400 1260 1250 1215 1110", ORANGE, 150))
    b.append(ellipse(800, 1580, 490, 400, ORANGE))
    b.append(head_path(540, 880, 490, 450, ORANGE, ear_h=1.22, ear_tip=0.64, ear_inner=0.31))
    b.append(masked_face(540, 880, 490, 450, CREAM, ORANGE))
    b.append(ellipse(690, 1470, 245, 220, CREAM))
    return svg("\n".join(b), SLATE)


def b2():
    b = []
    b.append(ellipse(960, 1700, 550, 430, ORANGE))
    b.append(head_path(620, 950, 520, 480, ORANGE, ear_h=1.18, ear_tip=0.65, ear_inner=0.32))
    b.append(masked_face(620, 950, 520, 480, CREAM, ORANGE, mouth=False))
    b.append(ellipse(700, 1660, 255, 230, CREAM))
    return svg("\n".join(b), SLATE)


# ---------------------------------------------------------------- direction C
# scarf-wearing baby otter / cocoa head + mustard mask / muted dusty teal
def c1():
    b = []
    b.append(ellipse(820, 1580, 490, 430, COCOA))
    b.append(circle(170, 700, 85, COCOA))
    b.append(circle(860, 700, 85, COCOA))
    b.append(ellipse(500, 880, 450, 330, COCOA))
    b.append(masked_face(500, 880, 450, 330, MUSTARD, COCOA))
    b.append(rrect(455, 1205, 545, 165, 82, MUSTARD, -2))                 # scarf band
    b.append(rrect(480, 1345, 150, 250, 75, MUSTARD, -2))                 # scarf end
    return svg("\n".join(b), TEAL)


def c2():
    b = []
    b.append(ellipse(920, 1680, 510, 430, COCOA))
    b.append(circle(255, 740, 90, COCOA))
    b.append(circle(950, 740, 90, COCOA))
    b.append(ellipse(600, 940, 480, 350, COCOA))
    b.append(masked_face(600, 940, 480, 350, MUSTARD, COCOA))
    b.append(rrect(560, 1265, 560, 175, 87, MUSTARD, -2))
    b.append(rrect(585, 1415, 155, 255, 78, MUSTARD, -2))
    return svg("\n".join(b), TEAL)


if __name__ == "__main__":
    items = {"A1": a1(), "A2": a2(), "B1": b1(), "B2": b2(), "C1": c1(), "C2": c2()}
    for name, content in items.items():
        with open(os.path.join(OUT, f"{name}.svg"), "w", encoding="utf-8") as f:
            f.write(content)
        print("wrote", name)
