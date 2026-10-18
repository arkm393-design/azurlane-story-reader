"""Stricter face placement: find scale + position where an expression patch
matches the painting pixel-for-pixel.

One expression is usually baked into the painting itself, so at the right
scale and spot the masked mean absolute difference (MAD) is tiny. The old
fitter used plain normalized cross-correlation, which also scores high on
any area of similar overall brightness (e.g. a skirt) and let a wrong-scale
match through.

fit(painting_path, face_paths) -> dict | None
  {"scale","x","y","w","h","mad","face","pw","ph"}; x,y,w,h in painting pixels.
"""
import os

import cv2
import numpy as np


def load_rgba(path):
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise SystemExit(f"cannot read {path}")
    if im.ndim == 2:
        im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGRA)
    if im.shape[2] == 3:
        im = cv2.cvtColor(im, cv2.COLOR_BGR2BGRA)
    return im


def _prep(face, scale):
    fh, fw = face.shape[:2]
    tw, th = max(4, round(fw * scale)), max(4, round(fh * scale))
    small = cv2.resize(face, (tw, th), interpolation=cv2.INTER_AREA)
    mask = (small[:, :, 3] > 240).astype(np.uint8)
    return small[:, :, :3], mask, tw, th


def _search(img, tpl, mask):
    """Masked CCOEFF_NORMED (mean-subtracted, so flat areas don't score)."""
    if img.shape[0] < tpl.shape[0] or img.shape[1] < tpl.shape[1] or mask.sum() < 50:
        return -1, None
    res = cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED, mask=mask * 255)
    res = np.nan_to_num(res, nan=-1, posinf=-1, neginf=-1)
    _, mx, _, loc = cv2.minMaxLoc(res)
    return mx, loc


def mad_at(paint, tpl, mask, x, y):
    region = paint[y:y + tpl.shape[0], x:x + tpl.shape[1], :3].astype(np.int16)
    if region.shape[:2] != tpl.shape[:2]:
        return 255.0
    diff = np.abs(region - tpl.astype(np.int16)).mean(axis=2)
    m = mask.astype(bool)
    return float(diff[m].mean()) if m.any() else 255.0


def _flat(face, scale):
    """Unmasked template for the fast coarse pass: transparent pixels take the patch's mean colour."""
    tpl, mask, tw, th = _prep(face, scale)
    if mask.sum():
        mean = tpl[mask.astype(bool)].mean(axis=0)
        tpl = tpl.copy()
        tpl[~mask.astype(bool)] = mean.astype(np.uint8)
    return tpl


def fit(painting_path, face_paths):
    paint = load_rgba(painting_path)
    faces = [(os.path.basename(p), load_rgba(p)) for p in face_paths]
    H, W = paint.shape[:2]
    img = paint[:, :, :3]
    k = min(1.0, 520 / max(H, W))
    small = cv2.resize(img, (round(W * k), round(H * k)), interpolation=cv2.INTER_AREA) if k < 1 else img
    cands = []
    for name, face in faces[:2]:
        fw = face.shape[1]
        top = min(2.2, W / fw)
        for s in np.arange(0.2, top + 1e-9, 0.02):
            tpl = _flat(face, s * k)
            if tpl.shape[0] >= small.shape[0] or tpl.shape[1] >= small.shape[1]:
                continue
            res = cv2.matchTemplate(small, tpl, cv2.TM_CCOEFF_NORMED)
            for _ in range(3):  # a few distinct peaks per scale
                _, mx, _, loc = cv2.minMaxLoc(res)
                cands.append((mx, s, loc))
                x0, y0 = max(0, loc[0] - tpl.shape[1] // 2), max(0, loc[1] - tpl.shape[0] // 2)
                res[y0:loc[1] + tpl.shape[0] // 2 + 1, x0:loc[0] + tpl.shape[1] // 2 + 1] = -1
    cands.sort(key=lambda c: -c[0])
    best = None
    seen = []
    for sc, s, loc in cands:
        if len(seen) >= 8:
            break
        if any(abs(s - s0) < 0.03 and abs(loc[0] - l0[0]) < 6 and abs(loc[1] - l0[1]) < 6 for s0, l0 in seen):
            continue
        seen.append((s, loc))
        cx, cy = loc[0] / k, loc[1] / k
        for name, face in faces:
            for s2 in np.arange(s - 0.02, s + 0.0201, 0.005):
                tpl, mask, tw, th = _prep(face, s2)
                pad = 16
                x0, y0 = max(0, int(cx - pad)), max(0, int(cy - pad))
                x1, y1 = min(W, int(cx + tw + pad)), min(H, int(cy + th + pad))
                sc2, l2 = _search(img[y0:y1, x0:x1], tpl, mask)
                if l2 is None:
                    continue
                x, y = l2[0] + x0, l2[1] + y0
                mad = mad_at(paint, tpl, mask, x, y)
                if best is None or mad < best["mad"]:
                    best = {"scale": round(float(s2), 4), "x": int(x), "y": int(y), "w": int(tw), "h": int(th),
                            "mad": round(mad, 2), "ccoeff": round(float(sc2), 4), "face": name, "pw": W, "ph": H}
    return best


def fit_head_via_shadow(painting_path, shadow_path, face_path):
    """Place a separate head layer on a headless painting using the game's
    "<name>_shadow" image, a darkened render of the complete figure.

    The body is located in the shadow by colour (its lower part is barely
    darkened); the head by its outline (alpha), which darkening leaves intact.
    Returns the head box in body-painting pixels (x/y may be negative: the head
    usually sits above the painting's top edge) plus both match scores.
    """
    sh = load_rgba(shadow_path)
    body = load_rgba(painting_path)
    head = load_rgba(face_path)
    SH, SW = sh.shape[:2]
    BH, BW = body.shape[:2]
    HH, HW = head.shape[:2]
    best = None
    for s in np.arange(0.85, 1.151, 0.01):
        b = cv2.resize(body, (round(BW * s), round(BH * s)), interpolation=cv2.INTER_AREA)
        cut = int(b.shape[0] * 0.6)
        part = b[cut:, :, :3]
        if part.shape[1] > SW or part.shape[0] > SH:
            continue
        res = cv2.matchTemplate(sh[:, :, :3], part, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(res)
        if best is None or mx > best[0]:
            best = (mx, float(s), loc[0], loc[1] - cut)
    if best is None:
        return None
    body_score, bs, bx, by = best
    region = sh[:max(1, by + int(BH * bs * 0.35)), :, 3].astype(np.float32)
    hbest = None
    for s in np.arange(0.7, 1.301, 0.01):
        h = cv2.resize(head, (round(HW * s), round(HH * s)), interpolation=cv2.INTER_AREA)
        ha = h[:, :, 3].astype(np.float32)
        if ha.shape[0] > region.shape[0] or ha.shape[1] > region.shape[1]:
            continue
        res = cv2.matchTemplate(region, ha, cv2.TM_CCOEFF_NORMED)
        res = np.nan_to_num(res, nan=-1, posinf=-1, neginf=-1)
        _, mx, _, loc = cv2.minMaxLoc(res)
        if hbest is None or mx > hbest[0]:
            hbest = (mx, float(s), loc[0], loc[1])
    if hbest is None:
        return None
    head_score, hs, hx, hy = hbest
    return {"x": (hx - bx) / bs, "y": (hy - by) / bs, "w": HW * hs / bs, "h": HH * hs / bs,
            "body_score": round(float(body_score), 4), "head_score": round(float(head_score), 4),
            "pw": BW, "ph": BH}


def fit_window(painting_path, face_path):
    """Place an expression patch that fills a window cut out of the painting
    (the default face is not baked in, so pixel matching finds nothing).

    Two signals: the patch's straight bottom edge continues the painting
    seamlessly (its last row matches the painting row just below), and the
    painting is empty wherever the patch is opaque (that is the window).
    Returns the box in painting pixels, the seam difference and the hole fraction.
    """
    paint = load_rgba(painting_path)
    face = load_rgba(face_path)
    H, W = paint.shape[:2]
    img = paint[:, :, :3].astype(np.float32)
    pa = paint[:, :, 3]
    best = None
    for s in np.arange(0.8, 1.2001, 0.01):
        tpl, mask, tw, th = _prep(face, float(s))
        if tw >= W or th >= H - 1:
            continue
        t = tpl.astype(np.float32)
        rmask = mask[th - 1:th]
        if rmask.sum() < tw * 0.25:
            continue
        res = cv2.matchTemplate(img[:H - 1], t[th - 1:th], cv2.TM_SQDIFF,
                                mask=np.repeat(rmask[:, :, None], 3, axis=2).astype(np.float32))
        res = np.nan_to_num(res, nan=1e12, posinf=1e12)
        opaque = mask.astype(bool)
        for _ in range(8):
            _, _, mn, _ = cv2.minMaxLoc(res)
            x, yr = mn
            res[max(0, yr - 3):yr + 4, max(0, x - 3):x + 4] = 1e12
            for dy in range(-2, 3):
                for dx in range(-1, 2):
                    x0, y0 = x + dx, yr - th + dy
                    if x0 < 0 or y0 < 0 or x0 + tw > W or y0 + th >= H:
                        continue
                    ok = (mask[th - 1] > 0) & (pa[y0 + th, x0:x0 + tw] > 240)
                    if ok.sum() < tw * 0.25:
                        continue
                    seam = float(np.abs(t[th - 1][ok] - img[y0 + th, x0:x0 + tw][ok]).mean())
                    hole = float((pa[y0:y0 + th, x0:x0 + tw][opaque] < 30).mean())
                    score = seam + 60 * (1 - hole)
                    if best is None or score < best["score"]:
                        best = {"scale": round(float(s), 4), "x": int(x0), "y": int(y0), "w": int(tw), "h": int(th),
                                "seam": round(seam, 2), "hole": round(hole, 3), "score": round(score, 2), "pw": W, "ph": H}
    return best


def locate_icon(painting_path, icon_path):
    """Find where a character's square icon (a face crop of the same art) sits in
    the painting. Used only to frame art that has no placed expressions.
    Returns the box as fractions of the painting plus the match score."""
    p = load_rgba(painting_path)
    q = load_rgba(icon_path)
    H, W = p.shape[:2]
    k = min(1.0, 700 / max(H, W))
    ps = cv2.resize(p, (round(W * k), round(H * k)), interpolation=cv2.INTER_AREA) if k < 1 else p

    def flat(im):  # transparent areas compare equal on mid grey
        a = im[:, :, 3:4] / 255.0
        return (im[:, :, :3] * a + 128 * (1 - a)).astype(np.uint8)

    P, Q = flat(ps), flat(q)
    best = None
    for side in range(40, int(min(P.shape[:2]) * 0.6), 4):
        t = cv2.resize(Q, (side, side), interpolation=cv2.INTER_AREA)
        res = cv2.matchTemplate(P, t, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(res)
        if best is None or mx > best[0]:
            best = (mx, side, loc)
    if best is None:
        return None
    mx, side, loc = best
    s = side / k
    return {"x": loc[0] / k / W, "y": loc[1] / k / H, "w": s / W, "h": s / H, "score": round(float(mx), 3)}
