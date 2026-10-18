"""Turn the game's raw art and music into the reader's shared asset library.

Every event adds only what the library does not have yet. The library lives in
<out>/ (site/assets/ by default) and is described by a manifest
(pipeline/state/assets.json):

  bg/<name>.webp           scene backgrounds (max 1600px wide)
  p/<painting>.webp        character art (max 1400px tall)
  f/<painting>/<e>.webp    expression patches, scaled to match p/
  a/<painting>.webp        portrait strip for the log and script views
  m/<track>.mp4            music (AAC)
  m/se/<name>.mp4          sound effects

manifest = {"paint": {name: entry}, "bg": {name: path}, "bgm": {...}, "se": {...}}
paint entry: w, h (pixels of p/), and one of
  face  {x,y,w,h as fractions, head?, def?}   expressions overlay the art here
  frame {x,y,w,h}                            no expressions; only frames the face
  po    {e: [...]}                           no full figure; portrait in the dialogue box
plus fx (expressions written to f/), av (frames in the portrait strip), fit/how (diagnostics).

Downloads land in a raw folder and are only ever decoded as images or audio.
"""
import concurrent.futures as cf
import json
import multiprocessing
import os
import subprocess

from PIL import Image

import facefit2

GOOD_MAD, GOOD_CC = 15.0, 0.85   # a face fit counts only if it matches nearly pixel for pixel
AVATAR = 128


class Source:
    """Index of a blobless AzurAssets clone; files are fetched on demand."""

    def __init__(self, repo, ref="origin/HEAD", raw_dir="cache/raw"):
        self.repo, self.ref, self.raw = repo, ref, raw_dir
        os.makedirs(raw_dir, exist_ok=True)
        out = subprocess.run(["git", "-C", repo, "ls-tree", "-r", "-z", ref],
                             check=True, capture_output=True).stdout.decode("utf-8")
        self.bg, self.paint, self.face, self.cue, self.se, self.sq = {}, {}, {}, {}, {}, {}
        self.oid = {}
        for rec in out.split("\0"):
            if "\t" not in rec:
                continue
            meta, path = rec.split("\t", 1)
            self.oid[path] = meta.split()[2]
            parts = path.split("/")
            if len(parts) < 3:
                continue
            kind, rest = parts[1], parts[2:]
            stem = rest[0].rsplit(".", 1)[0].lower()
            if kind == "bg" and len(rest) == 1:
                self.bg[stem] = path
            elif kind == "painting" and len(rest) == 1:
                self.paint[stem] = path
            elif kind == "squareicon" and len(rest) == 1:
                self.sq[stem] = path
            elif kind == "paintingface" and len(rest) == 2:
                self.face.setdefault(rest[0].lower(), {})[rest[1].rsplit(".", 1)[0]] = path
            elif kind == "cue" and len(rest) == 2 and rest[1].lower().endswith(".ogg"):
                self.cue.setdefault(rest[0].lower(), []).append(path)
                if rest[0].lower().startswith("se-"):
                    self.se[rest[1].rsplit(".", 1)[0].lower()] = path

    def dest(self, path):
        return os.path.join(self.raw, path.replace("/", "__"))

    def prefetch(self, paths):
        """Download the files not cached yet in a few batched requests, instead of one request per file."""
        oids = sorted({self.oid[p] for p in paths if p in self.oid and not os.path.exists(self.dest(p))})
        for i in range(0, len(oids), 400):
            r = subprocess.run(["git", "-C", self.repo, "-c", "fetch.negotiationAlgorithm=noop", "fetch", "-q",
                                "--no-tags", "--no-write-fetch-head", "--filter=blob:none", "origin", *oids[i:i + 400]],
                               capture_output=True)
            if r.returncode:   # not fatal: fetch() falls back to one request per file
                print("  batch download failed; fetching files one at a time")
                return

    def fetch(self, path):
        dest = self.dest(path)
        if not os.path.exists(dest) or os.path.getsize(dest) == 0:
            with open(dest + ".part", "wb") as fh:
                subprocess.run(["git", "-C", self.repo, "show", f"{self.ref}:{path}"], check=True, stdout=fh)
            os.replace(dest + ".part", dest)
        return dest


def _webp(im, path, quality):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "WEBP", quality=quality, method=6)


def _audio(src, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vn", "-c:a", "aac", "-b:a", "96k",
                    "-f", "mp4", path], check=True)


# ---------- one painting (runs in a worker process) ----------
_JOB = {}


def _paint_job(name):
    job = _JOB[name]
    out, src, faces, shadow, sq, wanted = job["out"], job["src"], job["faces"], job["shadow"], job["sq"], job["wanted"]
    face_paths = [faces[k] for k in job["fit_faces"] if k in faces]
    fit = facefit2.fit(src, face_paths) if face_paths else None
    im = Image.open(src).convert("RGBA")
    W, H = im.size
    k = min(1.0, 1400 / H, 1400 / W)
    nw, nh = round(W * k), round(H * k)
    entry = {"w": nw, "h": nh, "face": None, "fx": [], "fit": fit and {"mad": fit["mad"], "cc": fit["ccoeff"]}}
    fdir = os.path.join(out, "f", name)

    if fit and fit["mad"] <= GOOD_MAD and fit["ccoeff"] >= GOOD_CC:
        # expression patches overlay the painting at the matched spot
        _webp(im.resize((nw, nh), Image.LANCZOS) if k < 1 else im, os.path.join(out, "p", f"{name}.webp"), 80)
        s = fit["scale"]
        entry["face"] = {"x": fit["x"] / W, "y": fit["y"] / H, "w": fit["w"] / W, "h": fit["h"] / H}
        for e in wanted:
            if e in faces:
                fim = Image.open(faces[e]).convert("RGBA")
                tw, th = max(1, round(fim.width * s * k)), max(1, round(fim.height * s * k))
                _webp(fim.resize((tw, th), Image.LANCZOS), os.path.join(fdir, f"{e}.webp"), 85)
                entry["fx"].append(e)
        return name, entry

    big = face_paths and Image.open(face_paths[0]).width >= 0.2 * W
    if big:
        # a whole head (or head and shoulders) that is not baked into the art
        base_face = faces.get("0") or face_paths[0]
        hf, how = None, None
        if shadow:
            r = facefit2.fit_head_via_shadow(src, shadow, base_face)
            if r and r["body_score"] >= 0.98 and r["head_score"] >= 0.95:
                hf, how = r, "shadow"
        if not hf:
            r = facefit2.fit_window(src, base_face)
            if r and r["hole"] >= 0.6 and r["seam"] <= 40:
                hf, how = r, "window"
        if hf:
            left, top = max(0, -round(hf["x"])), max(0, -round(hf["y"]))
            right = max(0, round(hf["x"] + hf["w"]) - W)
            CW, CH = W + left + right, H + top
            canvas = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
            canvas.alpha_composite(im, (left, top))
            k2 = min(1.0, 1400 / CH, 1400 / CW)
            nw, nh = round(CW * k2), round(CH * k2)
            _webp(canvas.resize((nw, nh), Image.LANCZOS) if k2 < 1 else canvas, os.path.join(out, "p", f"{name}.webp"), 80)
            tw, th = max(1, round(hf["w"] * k2)), max(1, round(hf["h"] * k2))
            default = "0" if "0" in faces else os.path.basename(base_face).rsplit("__", 1)[-1].rsplit(".", 1)[0]
            for e in sorted(set(wanted) | {default}):
                if e in faces:
                    _webp(Image.open(faces[e]).convert("RGBA").resize((tw, th), Image.LANCZOS), os.path.join(fdir, f"{e}.webp"), 85)
                    entry["fx"].append(e)
            entry.update({"w": nw, "h": nh, "how": how,
                          "face": {"x": (hf["x"] + left) / CW, "y": (hf["y"] + top) / CH, "w": hf["w"] / CW,
                                   "h": hf["h"] / CH, "head": True, "def": default},
                          "fit": {x: v for x, v in hf.items() if x in ("body_score", "head_score", "seam", "hole")}})
            return name, entry

    _webp(im.resize((nw, nh), Image.LANCZOS) if k < 1 else im, os.path.join(out, "p", f"{name}.webp"), 80)
    if face_paths:
        if big:
            # nowhere to put the head: no figure; the head images become a portrait in the dialogue box
            saved = []
            for e in sorted(set(wanted) | {"0"}, key=lambda x: int(x) if x.isdigit() else 99):
                if e in faces:
                    fim = Image.open(faces[e]).convert("RGBA")
                    if fim.width > 640:
                        fim = fim.resize((640, round(fim.height * 640 / fim.width)), Image.LANCZOS)
                    _webp(fim, os.path.join(fdir, f"{e}.webp"), 85)
                    saved.append(e)
            if saved:
                entry["po"] = {"e": saved}
                entry["fx"] = saved
        # a face image still makes the best portrait for the log and script views
        pim = Image.open(face_paths[0]).convert("RGBA")
        pim.thumbnail((256, 256), Image.LANCZOS)
        _webp(pim, os.path.join(fdir, "portrait.webp"), 85)
        entry["portrait"] = True
    if not entry.get("po") and sq:
        loc = facefit2.locate_icon(src, sq)
        if loc and loc["score"] >= 0.85:
            entry["frame"] = {x: loc[x] for x in ("x", "y", "w", "h")}
    return name, entry


def process(need, src, out, manifest, log=print):
    """Add what `need` (from build_event.py) requires to the library. Returns names of paintings processed."""
    for key in ("paint", "bg", "bgm", "se"):
        manifest.setdefault(key, {})
    todo_bg = [n for n in need["bg"] if n not in manifest["bg"] and n in src.bg]
    todo_bgm = [n for n in need["bgm"] if n not in manifest["bgm"] and src.cue.get("bgm-" + n)]
    todo_se = [n for n in need.get("se", []) if n not in manifest["se"] and n in src.se]

    def paint_done(n):
        e = manifest["paint"].get(n)
        if not e:
            return False
        have = set(e.get("fx", []))
        if e.get("face") or e.get("po"):
            return set(need["faces"].get(n, [])) & set(src.face.get(n, {})) <= have
        return True

    todo_paint = [n for n in need["paint"] if n in src.paint and not paint_done(n)]
    missing = [n for n in need["paint"] if n not in src.paint] + [n for n in need["bg"] if n not in src.bg]
    log(f"to process: {len(todo_paint)} characters, {len(todo_bg)} backgrounds, {len(todo_bgm)} tracks, "
        f"{len(todo_se)} sound effects; not in the asset repo: {missing or 'none'}")

    # download
    fetch = {}
    for n in todo_bg:
        fetch[("bg", n)] = src.bg[n]
    for n in todo_bgm:
        fetch[("bgm", n)] = src.cue["bgm-" + n][0]
    for n in todo_se:
        fetch[("se", n)] = src.se[n]
    fit_faces = {}
    for n in todo_paint:
        fetch[("paint", n)] = src.paint[n]
        if n in src.sq:
            fetch[("sq", n)] = src.sq[n]
        if n + "_shadow" in src.paint:
            fetch[("shadow", n)] = src.paint[n + "_shadow"]
        faces = src.face.get(n, {})
        wanted = set(need["faces"].get(n, [])) | set((manifest["paint"].get(n) or {}).get("fx", []))
        pick = [x for x in sorted(faces, key=lambda x: int(x) if x.isdigit() else 99) if x in wanted or len(wanted) < 3][:6]
        fit_faces[n] = sorted(set(pick) | (wanted & set(faces)) | ({"0"} & set(faces)))
        for x in fit_faces[n]:
            fetch[("face", n, x)] = faces[x]
    src.prefetch(fetch.values())
    with cf.ThreadPoolExecutor(8) as pool:
        local = dict(zip(fetch, pool.map(src.fetch, fetch.values())))

    for n in todo_bg:
        im = Image.open(local[("bg", n)]).convert("RGB")
        if im.width > 1600:
            im = im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS)
        _webp(im, os.path.join(out, "bg", f"{n}.webp"), 76)
        manifest["bg"][n] = f"bg/{n}.webp"
    for n in todo_bgm:
        _audio(local[("bgm", n)], os.path.join(out, "m", f"{n}.mp4"))
        manifest["bgm"][n] = f"m/{n}.mp4"
    for n in todo_se:
        _audio(local[("se", n)], os.path.join(out, "m", "se", f"{n}.mp4"))
        manifest["se"][n] = f"m/se/{n}.mp4"

    _JOB.clear()
    for n in todo_paint:
        prev = manifest["paint"].get(n) or {}
        _JOB[n] = {"out": out, "src": local[("paint", n)], "shadow": local.get(("shadow", n)), "sq": local.get(("sq", n)),
                   "faces": {x: local[("face", n, x)] for x in fit_faces[n]}, "fit_faces": fit_faces[n],
                   "wanted": sorted(set(need["faces"].get(n, [])) | set(prev.get("fx", [])))}
    if todo_paint:
        ctx = multiprocessing.get_context("fork")
        with cf.ProcessPoolExecutor(max(2, os.cpu_count() or 2), mp_context=ctx) as pool:
            for n, entry in pool.map(_paint_job, todo_paint):
                manifest["paint"][n] = entry
    return todo_paint


def _square(im, cx, cy, side):
    box = (round(cx - side / 2), round(cy - side / 2), round(cx + side / 2), round(cy + side / 2))
    out = Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), (0, 0, 0, 0))
    out.alpha_composite(im.crop((max(0, box[0]), max(0, box[1]), min(im.width, box[2]), min(im.height, box[3]))),
                        (max(0, -box[0]), max(0, -box[1])))
    return out.resize((AVATAR, AVATAR), Image.LANCZOS)


def avatars(out, manifest, names):
    """Portrait strips for the log and script views: frame "0" is the art as drawn,
    then one frame per expression written for that character."""
    for name in names:
        entry = manifest["paint"].get(name)
        if not entry:
            continue
        fdir = os.path.join(out, "f", name)
        if entry.get("po") or entry.get("portrait"):
            frames = entry["po"]["e"] if entry.get("po") else ["portrait"]
            tiles = []
            for e in frames:
                im = Image.open(os.path.join(fdir, f"{e}.webp")).convert("RGBA")
                side = round(min(im.width, im.height) * 0.92)
                tiles.append(_square(im, im.width / 2, im.height * 0.48, side))
            entry["av"] = ["0" if f == "portrait" else f for f in frames]
        else:
            base = Image.open(os.path.join(out, "p", f"{name}.webp")).convert("RGBA")
            W, H = base.size
            face = entry.get("face") or entry.get("frame")
            if face:
                cx = (face["x"] + face["w"] / 2) * W
                if face.get("head"):
                    cy, side = (face["y"] + face["h"] * 0.5) * H, face["w"] * W * 1.05
                else:
                    cy, side = (face["y"] + face["h"] * 0.55) * H, face["w"] * W * 1.9
            else:
                bbox = base.getbbox() or (0, 0, W, H)
                side = (bbox[2] - bbox[0]) * 0.32
                cx, cy = (bbox[0] + bbox[2]) / 2, bbox[1] + side * 0.75
            exprs = sorted(entry.get("fx", []), key=lambda x: int(x) if x.isdigit() else 99) if entry.get("face") else []
            frames = ["0"] + [e for e in exprs if e != (entry["face"] or {}).get("def")] if entry.get("face") else ["0"]
            tiles = []
            for e in frames:
                im = base.copy()
                pe = e if e != "0" else (entry.get("face") or {}).get("def")
                if pe:
                    im.alpha_composite(Image.open(os.path.join(fdir, f"{pe}.webp")).convert("RGBA"),
                                       (round(face["x"] * W), round(face["y"] * H)))
                tiles.append(_square(im, cx, cy, side))
            entry["av"] = frames
        strip = Image.new("RGBA", (AVATAR * len(tiles), AVATAR), (0, 0, 0, 0))
        for i, t in enumerate(tiles):
            strip.alpha_composite(t, (i * AVATAR, 0))
        _webp(strip, os.path.join(out, "a", f"{name}.webp"), 82)


def report(manifest, names):
    out = {}
    for n in names:
        e = manifest["paint"].get(n) or {}
        if e.get("face", {}) and e["face"].get("head"):
            out[n] = f"large patch placed via {e.get('how')}"
        elif e.get("face"):
            continue
        elif e.get("po"):
            out[n] = "portrait beside the dialogue (no figure)"
        elif e.get("frame"):
            out[n] = "no expressions; framed by icon"
        else:
            out[n] = "no expressions; default framing"
    return out
