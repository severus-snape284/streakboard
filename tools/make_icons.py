"""Generate placeholder PNG icons (original flame mark). Run: python3 tools/make_icons.py"""
from PIL import Image, ImageDraw, ImageFilter

BG = (14, 14, 18)
OUTER = (255, 138, 61)
INNER = (255, 194, 74)


def flame(draw, cx, cy, s, color):
    # Teardrop flame: a circle base with a pointed top, built from a polygon + ellipse.
    r = s * 0.5
    draw.ellipse([cx - r, cy - r * 0.2, cx + r, cy + r * 1.8], fill=color)
    draw.polygon([(cx - r * 0.98, cy + r * 0.75), (cx + r * 0.15, cy - r * 1.9),
                  (cx + r * 0.55, cy - r * 0.4), (cx + r * 0.98, cy + r * 0.75)], fill=color)


def make(size, maskable=False, rounded=False):
    scale = 4
    S = size * scale
    img = Image.new('RGBA', (S, S), BG + (255,))
    d = ImageDraw.Draw(img)
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([S * 0.2, S * 0.25, S * 0.8, S * 0.85], fill=OUTER + (70,))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(S * 0.08)))
    d = ImageDraw.Draw(img)
    k = 0.62 if maskable else 0.8  # maskable keeps the mark inside the safe zone
    unit = S * k
    ro = unit * 0.23  # outer flame radius; the shape spans 3.7 radii vertically
    cx, cy = S / 2, S / 2
    flame(d, cx, cy, ro * 2, OUTER)
    flame(d, cx + ro * 0.05, cy + ro * 0.7, ro, INNER)
    img = img.resize((size, size), Image.LANCZOS)
    if rounded:
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=255)
        img.putalpha(mask)
    return img


make(180).convert('RGB').save('icons/apple-touch-icon.png')
make(192, rounded=True).save('icons/icon-192.png')
make(512, rounded=True).save('icons/icon-512.png')
make(512, maskable=True).convert('RGB').save('icons/icon-maskable-512.png')
