"""Pre-render assets/icon.png into the half-block ANSI banner embedded in bin/nomo-ai.mjs.

Run:  uv run --with pillow tools/make-banner.py [--preview] [--cols N]

Not shipped: package.json `files` is ["bin/"], so nothing here reaches the tarball. The installer
must stay dependency-free and never touch assets/ at run time (the tarball has no assets/), so this
runs by hand and its output is pasted in.

Two half-pixels per cell via U+2580 / U+2584: foreground paints one half, background the other, and
a cell with only one live half leaves the other the terminal's own background. That is what drops
the icon's near-white ground instead of painting it -- a white slab in a terminal reads as a
rendering bug, not a logo.

The colours are deliberately NOT the icon's. The art is drawn against white, so its palest tones
would all but vanish on a light terminal; every kept pixel is pulled down in lightness (see
LUM_SCALE / LUM_CAP) at partly-held chroma (CHROMA_HOLD), which is what makes ONE banner legible on
a light and a dark terminal both. The tuning target is the silhouette-edge contrast ratio against
white and against #1a1b1e; at the values here the worst edge cell is 2.12 : 1 on white and
1.99 : 1 on dark.
"""

import argparse
import colorsys
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

# What counts as ink. The art is drawn on white, so "how far from white" IS its alpha: the arc fades
# to near-white at its inner edge and that fade should become transparency, not a solid mauve slab
# that fattens a thin sweep into a wedge. min(r,g,b) is the cheap read of it -- white is 255, the
# dark eyes are ~30 -- and it keeps dark low-chroma pixels a saturation test would throw away.
INK_MIN = 55
# ...and the icon's drop shadow, which is neutral grey. It survives the whiteness test where it
# overlaps the coral (the mix is a light tan) and reads in a terminal as a dirty smear under the
# arc, so anything light and near-colourless is ground too.
SHADOW_CHROMA = 0.16
SHADOW_LUM = 0.68

LUM_SCALE = 0.86   # pull everything down off white...
LUM_CAP = 0.70     # ...and hard-cap it, so nothing lands too close to a white terminal
CHROMA_HOLD = 0.4  # 0 = keep HLS saturation (vivid, drifts), 1 = keep chroma (faithful, dusty)
QUANT = 24         # round channels to this step: fewer distinct colours, longer runs, fewer escapes


def transform(rgb):
    """Darken at CONSTANT chroma. Naively lowering HLS lightness holds saturation, and saturation is
    a ratio against the room a given lightness leaves -- so the same s at a darker l is a wider
    colour, and the icon's blue-violet face comes out electric. Re-solving s to keep chroma where it
    was darkens without changing the colour."""
    h, l, s = colorsys.rgb_to_hls(*(c / 255 for c in rgb))
    chroma = (1 - abs(2 * l - 1)) * s
    l = min(l * LUM_SCALE, LUM_CAP)
    room = 1 - abs(2 * l - 1)
    keep = min(1.0, chroma / room) if room else 0
    out = colorsys.hls_to_rgb(h, l, s * (1 - CHROMA_HOLD) + keep * CHROMA_HOLD)
    return tuple(min(255, max(0, round(c * 255 / QUANT) * QUANT)) for c in out)


def is_ground(rgb):
    if 255 - min(rgb) < INK_MIN:
        return True
    chroma = (max(rgb) - min(rgb)) / 255
    lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255
    return chroma < SHADOW_CHROMA and lum > SHADOW_LUM


def sample(cols):
    im = Image.open(ROOT / "assets" / "icon.png").convert("RGBA")
    im = Image.alpha_composite(Image.new("RGBA", im.size, (255, 255, 255, 255)), im).convert("RGB")

    # Crop to the ink, not to the rounded square: the square IS the ground we are dropping.
    px = im.load()
    w, h = im.size
    box = [w, h, 0, 0]
    for y in range(h):
        for x in range(w):
            if not is_ground(px[x, y]):
                box[0] = min(box[0], x); box[1] = min(box[1], y)
                box[2] = max(box[2], x + 1); box[3] = max(box[3], y + 1)
    im = im.crop(tuple(box))

    # One half-pixel is one cell wide and half a cell tall, i.e. square on a ~1:2 terminal cell.
    # So the sample grid just keeps the crop's own aspect ratio.
    cw, ch = im.size
    rows = round(cols * ch / cw)
    rows += rows % 2  # whole cells
    # Small dark features (the two eyes) are ~1.5 samples wide at this size and LANCZOS averages
    # them into the face. A pre-downscale unsharp pass is what keeps them from vanishing.
    im = im.filter(ImageFilter.UnsharpMask(radius=cw / cols, percent=110, threshold=6))
    im = im.resize((cols, rows), Image.LANCZOS)

    px = im.load()
    grid = [[None if is_ground(px[x, y]) else transform(px[x, y]) for x in range(cols)] for y in range(rows)]

    # Despeckle. The arc's antialiased tip leaves a lone surviving sample floating in the gap between
    # the arc and the face, and one isolated cell in a terminal does not read as art, it reads as
    # dirt on the screen. Anything with fewer than two ink neighbours goes.
    live = lambda y, x: 0 <= y < rows and 0 <= x < cols and grid[y][x] is not None
    return [
        [
            c if c is None or sum(live(y + dy, x + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)) - 1 >= 2 else None
            for x, c in enumerate(row)
        ]
        for y, row in enumerate(grid)
    ]


def render(grid, label_rows=()):
    """Half-blocks with run-length escape elision: emit a colour only when it changes.

    Rows in label_rows keep their trailing spaces so the caller can concatenate text at a fixed
    column: once a line carries ANSI, .length is no longer its printed width, so the padding has to
    be baked in here where the cell count is still known."""
    lines = []
    for y in range(0, len(grid), 2):
        top, bot = grid[y], grid[y + 1] if y + 1 < len(grid) else [None] * len(grid[y])
        out, fg, bg = [], None, None
        for x in range(len(top)):
            t, b = top[x], bot[x]
            # A cell with one live half uses the block that paints only that half, so the dead half
            # stays the terminal's own background instead of a guessed colour. That is what makes the
            # icon's near-white ground droppable: nothing is painted where the ground was.
            if t is None and b is None:
                char, want_fg, want_bg = " ", fg, None
            elif t is None:
                char, want_fg, want_bg = "\u2584", b, None
            else:
                char, want_fg, want_bg = "\u2580", t, b
            # One SGR per cell, carrying only what changed: 38;2 and 48;2 merge into a single escape.
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
        line = "".join(out)
        trimmed = line.rstrip()
        # A trailing "back to default bg" is redundant right before the full reset.
        if trimmed.endswith("\x1b[49m"):
            trimmed = trimmed[: -len("\x1b[49m")]
        pad = " " * (len(line) - len(line.rstrip())) if y // 2 in label_rows else ""
        lines.append(trimmed + "\x1b[0m" + pad if trimmed else pad)
    return lines


def to_png(grid, path, bg, cell=(9, 20)):
    """Exactly what a terminal paints, so the result can be looked at instead of imagined:
    one cell = cell px, top half the fg colour, bottom half the bg colour, dead halves the
    terminal's own background."""
    cw, chh = cell
    half = chh // 2
    im = Image.new("RGB", (len(grid[0]) * cw, (len(grid) // 2) * chh), bg)
    px = im.load()
    for y, row in enumerate(grid):
        for x, c in enumerate(row):
            if c is None:
                continue
            y0 = (y // 2) * chh + (y % 2) * half
            for yy in range(y0, y0 + half):
                for xx in range(x * cw, (x + 1) * cw):
                    px[xx, yy] = c
    im.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=24)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--png")
    ap.add_argument("--label-rows", default="6,7")
    ap.add_argument("--indent", type=int, default=2)
    args = ap.parse_args()
    label_rows = {int(n) for n in args.label_rows.split(",") if n != ""}

    grid = sample(args.cols)
    if args.png:
        to_png(grid, args.png + ".dark.png", (26, 27, 30))
        to_png(grid, args.png + ".light.png", (255, 255, 255))
        return
    lines = [(" " * args.indent + l if l else l) for l in render(grid, label_rows)]
    if args.preview:
        print("\n".join(lines))
        print(f"\n{len(lines)} rows x {args.cols} cols, {sum(len(l) for l in lines)} bytes of string")
        return

    body = ",\n".join('  "%s"' % l.replace("\\", "\\\\").replace('"', '\\"').replace("\x1b", "\\u001b") for l in lines)
    print("const ART = [\n%s,\n];" % body)


if __name__ == "__main__":
    main()
