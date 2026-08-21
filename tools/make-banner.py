"""Pre-render assets/icon.png into a half-block ANSI banner for bin/nomo-ai.mjs.

    uv run --with pillow tools/make-banner.py --preview
    uv run --with pillow tools/make-banner.py --png /tmp/opt-a   # dark + light PNGs to look at

NOT CURRENTLY SHIPPED. bin/nomo-ai.mjs draws a typographic lockup instead, and that was a finding,
not a shortcut: the Nomo mark is a soft pastel gradient with no strong silhouette, and at the 6-9
rows that can sit above a 15-line install plan it collapses into a coral smudge next to a blue lump
no matter which technique draws it. Half-blocks, character-density ramps, an ASCII shade ramp, the
arc alone, and a redrawn thin concentric sweep were all rendered to PNG and looked at; the smallest
readable picture was still worse than no picture. This file survives so that call can be re-taken
cheaply rather than re-derived -- run --preview and look.

Not in the tarball either: package.json `files` is ["bin/"]. The installer must stay dependency-free
and never touch assets/ at run time, so this runs by hand and its output is pasted in.

Two half-pixels per cell via U+2580 / U+2584: the foreground paints one half, the background the
other, and a cell with only one live half leaves the other the terminal's own background. That is
what drops the icon's near-white ground instead of painting it -- a white slab in a terminal reads
as a rendering bug, not a logo.

Two things here are load-bearing and were both wrong in the first pass:

  * COVERAGE AND COLOUR ARE SAMPLED SEPARATELY. Resampling the RGB and then asking "is this pixel
    white?" averages the white ground into every edge cell, which fattens a thin sweep into a wedge
    and washes the coral to salmon. Instead a 1-bit ink mask is box-filtered to a coverage fraction
    (that decides which cells are ink), and the colour is averaged over the ink pixels ONLY.
  * THE DARKENING IS A SCALAR MULTIPLY. The source is drawn on white and its palest tones would
    vanish on a light terminal, so everything is pulled down -- but in HLS. Lowering lightness at
    held saturation widens the colour, because saturation is a ratio against the room a given
    lightness leaves; that is what turned the periwinkle blob electric indigo. Multiplying RGB by a
    scalar darkens at EXACTLY the source hue and saturation ratio. Boring, and correct.
"""

import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# What counts as ink. The art is drawn on white, so "how far from white" IS its alpha.
INK_MIN = 55
# ...and the icon's drop shadow, which is neutral grey and reads in a terminal as a dirty smear.
SHADOW_CHROMA = 0.16
SHADOW_LUM = 0.68

COVERAGE = 0.42  # a cell is ink once this much of it is ink
DARKEN = 0.72    # scalar multiply -- see the module docstring
QUANT = 16       # round channels to this step: fewer distinct colours, fewer escapes


def is_ground(rgb):
    if 255 - min(rgb) < INK_MIN:
        return True
    chroma = (max(rgb) - min(rgb)) / 255
    lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255
    return chroma < SHADOW_CHROMA and lum > SHADOW_LUM


def load(arc_only):
    im = Image.open(ROOT / "assets" / "icon.png").convert("RGBA")
    im = Image.alpha_composite(Image.new("RGBA", im.size, (255, 255, 255, 255)), im).convert("RGB")
    w, h = im.size
    px = im.load()
    mask = [[0 if is_ground(px[x, y]) else 1 for x in range(w)] for y in range(h)]
    if arc_only:  # the face is the blue lobe
        for y in range(h):
            for x in range(w):
                r, _, b = px[x, y]
                if b > r + 20:
                    mask[y][x] = 0
    return im, mask


def sample(cols, rows, arc_only=False):
    """-> live[r][c], colour[r][c]. rows counts HALF-pixels, so 2 per terminal row."""
    im, mask = load(arc_only)
    h, w = len(mask), len(mask[0])
    xs = [x for x in range(w) if any(mask[y][x] for y in range(h))]
    ys = [y for y in range(h) if any(mask[y])]
    # Crop to the ink, not to the rounded square: the square IS the ground we are dropping.
    x0, y0, W, H = xs[0], ys[0], xs[-1] + 1 - xs[0], ys[-1] + 1 - ys[0]

    px = im.load()
    cov = [[0.0] * cols for _ in range(rows)]
    col = [[None] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            sx0, sx1 = x0 + round(c * W / cols), x0 + round((c + 1) * W / cols)
            sy0, sy1 = y0 + round(r * H / rows), y0 + round((r + 1) * H / rows)
            n = tot = 0
            acc = [0, 0, 0]
            for y in range(sy0, max(sy1, sy0 + 1)):
                for x in range(sx0, max(sx1, sx0 + 1)):
                    tot += 1
                    if mask[y][x]:
                        n += 1
                        for i, v in enumerate(px[x, y]):
                            acc[i] += v
            cov[r][c] = n / tot if tot else 0
            if n:
                col[r][c] = tuple(a // n for a in acc)

    # Despeckle, twice. The arc's antialiased terminus leaves a few surviving cells hanging in the
    # gap below it, and a lone cell in a terminal does not read as art, it reads as dirt on the
    # screen. One pass leaves the survivors of the survivors, hence two.
    live = [[cov[r][c] >= COVERAGE for c in range(cols)] for r in range(rows)]
    for _ in range(2):
        nxt = [row[:] for row in live]
        for r in range(rows):
            for c in range(cols):
                if live[r][c]:
                    n = sum(
                        live[r + dr][c + dc]
                        for dr in (-1, 0, 1)
                        for dc in (-1, 0, 1)
                        if 0 <= r + dr < rows and 0 <= c + dc < cols
                    ) - 1
                    if n < 3:
                        nxt[r][c] = False
        live = nxt
    return live, col


def darken(rgb):
    return tuple(min(255, round(c * DARKEN / QUANT) * QUANT) for c in rgb)


def render(cols, rows, **kw):
    """Half-blocks with run-length escape elision: emit a colour only when it changes."""
    live, col = sample(cols, rows * 2, **kw)
    lines = []
    for y in range(0, rows * 2, 2):
        out, fg, bg = [], None, None
        for x in range(cols):
            t = darken(col[y][x]) if live[y][x] else None
            b = darken(col[y + 1][x]) if live[y + 1][x] else None
            # A cell with one live half uses the block that paints only that half, so the dead half
            # stays the terminal's own background instead of a guessed colour.
            if t is None and b is None:
                char, want_fg, want_bg = " ", fg, None
            elif t is None:
                char, want_fg, want_bg = "\u2584", b, None
            else:
                char, want_fg, want_bg = "\u2580", t, b
            sgr = []
            if want_bg is None and bg is not None:
                sgr.append("49")
                bg = None
            if want_fg is not None and want_fg != fg:
                sgr.append("38;2;%d;%d;%d" % want_fg)
                fg = want_fg
            if want_bg is not None and want_bg != bg:
                sgr.append("48;2;%d;%d;%d" % want_bg)
                bg = want_bg
            if sgr:
                out.append("\x1b[" + ";".join(sgr) + "m")
            out.append(char)
        line = "".join(out).rstrip()
        if line.endswith("\x1b[49m"):
            line = line[: -len("\x1b[49m")]
        lines.append(line + "\x1b[0m" if line else "")
    return lines


def to_png(cols, rows, path, bg, cell=(11, 24), **kw):
    """Exactly what a terminal paints, so the result can be looked at instead of imagined."""
    live, col = sample(cols, rows * 2, **kw)
    cw, chh = cell
    half = chh // 2
    im = Image.new("RGB", (cols * cw, rows * chh), bg)
    px = im.load()
    for y in range(rows * 2):
        for x in range(cols):
            if not live[y][x]:
                continue
            c = darken(col[y][x])
            y0 = (y // 2) * chh + (y % 2) * half
            for yy in range(y0, y0 + half):
                for xx in range(x * cw, (x + 1) * cw):
                    px[xx, yy] = c
    im.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=16)
    ap.add_argument("--rows", type=int, default=8, help="terminal rows, i.e. half the half-pixels")
    ap.add_argument("--arc-only", action="store_true", help="drop the face, keep the sweep")
    ap.add_argument("--indent", type=int, default=2)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--png", help="write <arg>.dark.png and <arg>.light.png and stop")
    args = ap.parse_args()
    kw = dict(arc_only=args.arc_only)

    if args.png:
        to_png(args.cols, args.rows, args.png + ".dark.png", (26, 27, 30), **kw)
        to_png(args.cols, args.rows, args.png + ".light.png", (255, 255, 255), **kw)
        return

    lines = [(" " * args.indent + l if l else l) for l in render(args.cols, args.rows, **kw)]
    if args.preview:
        print("\n".join(lines))
        print(f"\n{len(lines)} rows x {args.cols} cols, {sum(len(l) for l in lines)} bytes")
        return
    body = ",\n".join(
        '  "%s"' % l.replace("\\", "\\\\").replace('"', '\\"').replace("\x1b", "\\u001b")
        for l in lines
    )
    print("const ART = [\n%s,\n];" % body)


if __name__ == "__main__":
    main()
