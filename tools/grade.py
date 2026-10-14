# One TrueStay grade for every photo: neutralise the cast, even out exposure and colour strength,
# then the shared look (clean charcoal shadows, warm cream highlights, gentle contrast, soft blacks).
import numpy as np
from PIL import Image

def s2l(c): return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def l2s(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]])
M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]])
def lin2ok(l): return np.cbrt(l @ M1.T) @ M2.T
def ok2lin(o):
    lms = (o @ np.linalg.inv(M2).T) ** 3
    return lms @ np.linalg.inv(M1).T

def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)

def grade(img, wb=0.85, normalise=True, look=True):
    a = np.asarray(img.convert("RGB")).astype(np.float32) / 255
    l = s2l(a)
    if normalise:
        Y = l @ np.array([0.2126, 0.7152, 0.0722])
        m = (Y > 0.01) & (Y < 0.9)
        est = np.array([(l[..., i][m] ** 6).mean() ** (1 / 6) for i in range(3)])
        est /= est.mean()
        gains = est ** -wb
        gains /= (gains @ np.array([0.2126, 0.7152, 0.0722]))  # keep brightness
        l = l * gains
    o = lin2ok(np.clip(l, 0, None))
    L, A, B = o[..., 0], o[..., 1], o[..., 2]
    if normalise:
        # even out exposure: black and white points, then midtones
        lo, mid, hi = np.percentile(L, [0.8, 50, 99.6])
        Ln = np.clip((L - lo) / max(hi - lo, 1e-3), 0, 1)
        midn = np.clip((mid - lo) / max(hi - lo, 1e-3), 0.05, 0.95)
        target_mid = 0.56
        g = np.log(target_mid) / np.log(midn)
        g = np.clip(g, 0.6, 1.6)
        L = Ln ** g
        # even out colour strength
        C = np.hypot(A, B)
        mm = (L > 0.25) & (L < 0.9)
        f = np.clip(0.028 / max(C[mm].mean(), 1e-4), 0.6, 1.3)
        A, B = A * f, B * f
    if look:
        # gentle S curve
        L = L + 0.55 * (smooth(0, 1, L) - L)
        # shadows go clean charcoal: drain colour out of the darks
        keep = 0.35 + 0.65 * smooth(0.12, 0.55, L)
        A, B = A * keep, B * keep
        # one shared warmth: cream highlights, a touch of warmth in the mids
        w = smooth(0.45, 1.0, L)
        A = A + 0.005 * w + 0.003 * (1 - w) * smooth(0.2, 0.5, L)
        B = B + 0.019 * w + 0.007 * (1 - w) * smooth(0.2, 0.5, L)
        # calm the gym blues (walls, floors, strip lights) so every photo sits in the same warm world
        h = np.degrees(np.arctan2(B, A))
        blue = smooth(-185, -150, h) * (1 - smooth(-85, -60, h))
        A, B = A * (1 - 0.45 * blue), B * (1 - 0.45 * blue)
        # keep skin alive: warm hues (skin, wood) keep more of their colour than everything else
        h = np.degrees(np.arctan2(B, A))
        skin = smooth(15, 40, h) * (1 - smooth(85, 110, h)) * smooth(0.3, 0.5, L)
        C = np.hypot(A, B)
        lift = 1 + skin * np.clip((0.05 - C) / 0.05, 0, 1) * 0.55
        A, B = A * lift, B * lift
        # overall colour quieter, so the orange on the page does the shouting
        A, B = A * 0.8, B * 0.8
        # soft blacks and creamy (not paper white) top end
        L = 0.15 + L * (0.965 - 0.15)
    out = l2s(ok2lin(np.stack([L, A, B], -1)))
    return Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8))

if __name__ == "__main__":
    # python3 tools/grade.py photo.jpg public/coaching/img/name [--widths 640 960 1280] [--crop x0 y0 x1 y1] [--look-only]
    # Writes name-<width>.webp for each width. Crop is in pixels of the original photo.
    import argparse
    ap = argparse.ArgumentParser(description="Give a photo the TrueStay grade and save web sizes")
    ap.add_argument("photo")
    ap.add_argument("out", help="output path without the -<width>.webp ending")
    ap.add_argument("--widths", type=int, nargs="+", default=[640, 960, 1280])
    ap.add_argument("--crop", type=int, nargs=4, metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--look-only", action="store_true", help="skip evening out the colour and exposure (graphics, cartoons, posters)")
    ap.add_argument("--quality", type=int, default=74)
    a = ap.parse_args()
    im = grade(Image.open(a.photo), normalise=not a.look_only)
    if a.crop:
        im = im.crop(tuple(a.crop))
    for w in a.widths:
        w = min(w, im.width)
        r = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        r.save(f"{a.out}-{w}.webp", "WEBP", quality=a.quality, method=6)
        print(f"{a.out}-{w}.webp", r.size)
