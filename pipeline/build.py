"""Build the reader's story data and art library, one event at a time.

  python pipeline/build.py list [words]   story groups in the game data (id, kind, chapters, title)
  python pipeline/build.py add <id>       build a story group and publish it in the library
  python pipeline/build.py rebuild <id>   rebuild a published group (story text and any art it lacks)
  python pipeline/build.py remove <id>    unpublish a group (its art stays in the library)
  python pipeline/build.py refresh        rewrite site/data from pipeline/state (no downloads)

Options: --update  fetch the latest game data and assets first.

Sources (fetched into cache/src as blobless git clones; nothing from them is executed):
  AzurLaneData  https://github.com/AzurLaneTools/AzurLaneData  (story text and game tables, EN server)
  AzurAssets    https://github.com/Fernando2603/AzurAssets      (art and music, EN server)

Per-event fixes go in config/overrides/<id>.json (see build_event.py).
"""
import datetime
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import assets  # noqa: E402

ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, "cache")
STATE = os.path.join(HERE, "state")
SITE = os.path.join(ROOT, "site")
CONFIG = os.path.join(ROOT, "config")
OUT_ASSETS = os.path.join(SITE, "assets")
MANIFEST = os.path.join(STATE, "assets.json")
NEEDS = os.path.join(STATE, "needs.json")
EVENTS_CFG = os.path.join(CONFIG, "events.json")

REPOS = {
    "AzurLaneData": "https://github.com/AzurLaneTools/AzurLaneData.git",
    "AzurAssets": "https://github.com/Fernando2603/AzurAssets.git",
}
REF = "origin/HEAD"
DATA_FILES = {
    "story": "EN/GameCfg/story.json",
    "memory_group": "EN/ShareCfg/memory_group.json",
    "memory_template": "EN/ShareCfg/memory_template.json",
    "ship_skin_template": "EN/ShareCfg/ship_skin_template.json",
    "ship_data_statistics": "EN/sharecfgdata/ship_data_statistics.json",
    "name_code": "EN/ShareCfg/name_code.json",
    "chapter_template": "EN/sharecfgdata/chapter_template.json",
    "expedition_data_by_map": "EN/ShareCfg/expedition_data_by_map.json",
}


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def write_json(path, obj, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as fh:
        if compact:
            json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, fh, ensure_ascii=False, indent=1, sort_keys=True)
            fh.write("\n")
    os.replace(path + ".tmp", path)


def sources(update=False):
    os.makedirs(os.path.join(CACHE, "src"), exist_ok=True)
    for name, url in REPOS.items():
        d = os.path.join(CACHE, "src", name)
        if not os.path.isdir(d):
            print(f"cloning {name} (file list only; files are fetched as needed)")
            subprocess.run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", "--depth", "1", url, d], check=True)
        elif update:
            print(f"updating {name}")
            subprocess.run(["git", "-C", d, "fetch", "-q", "--depth", "1", "origin"], check=True)
    data_dir = os.path.join(CACHE, "data")
    os.makedirs(data_dir, exist_ok=True)
    repo = os.path.join(CACHE, "src", "AzurLaneData")
    for name, path in DATA_FILES.items():
        dest = os.path.join(data_dir, name + ".json")
        if update or not os.path.exists(dest):
            with open(dest + ".part", "wb") as fh:
                subprocess.run(["git", "-C", repo, "show", f"{REF}:{path}"], check=True, stdout=fh)
            os.replace(dest + ".part", dest)
    return data_dir


def published():
    return read_json(EVENTS_CFG, {"events": []})["events"]


def build_story(gid, data_dir):
    out = os.path.join(STATE, "events", f"{gid}.json")
    cmd = [sys.executable, "-I", os.path.join(HERE, "build_event.py"), data_dir, str(gid), out]
    ovr = os.path.join(CONFIG, "overrides", f"{gid}.json")
    if os.path.exists(ovr):
        cmd.append(ovr)
    subprocess.run(cmd, check=True)
    return read_json(out, None)


def build_assets(gid, story):
    src = assets.Source(os.path.join(CACHE, "src", "AzurAssets"), REF, os.path.join(CACHE, "raw"))
    manifest = read_json(MANIFEST, {})
    done = assets.process(story["need"], src, OUT_ASSETS, manifest)
    assets.avatars(OUT_ASSETS, manifest, done)
    needs = read_json(NEEDS, {})
    needs[str(gid)] = story["need"]
    write_json(MANIFEST, manifest)
    write_json(NEEDS, needs)
    issues = assets.report(manifest, story["need"]["paint"])
    for n, why in sorted(issues.items()):
        print(f"  note: {n}: {why}")


PAINT_KEYS = ("w", "h", "face", "frame", "po", "portrait", "av")


def refresh():
    """Rewrite site/data/ (catalog and per-event files) from pipeline/state/."""
    manifest = read_json(MANIFEST, {"paint": {}, "bg": {}, "bgm": {}, "se": {}})
    catalog = []
    live = set()
    for item in published():
        gid = item["id"]
        story = read_json(os.path.join(STATE, "events", f"{gid}.json"), None)
        if not story:
            print(f"skipping {gid}: not built yet")
            continue
        need = story.pop("need")
        story["assets"] = {
            "paint": {n: {k: v for k, v in manifest["paint"][n].items() if k in PAINT_KEYS}
                      for n in need["paint"] if n in manifest["paint"]},
            "bg": {n: manifest["bg"][n] for n in need["bg"] if n in manifest["bg"]},
            "bgm": {n: manifest["bgm"][n] for n in need["bgm"] if n in manifest["bgm"]},
            "se": {n: manifest["se"][n] for n in need.get("se", []) if n in manifest["se"]},
        }
        write_json(os.path.join(SITE, "data", "events", f"{gid}.json"), story, compact=True)
        live.add(f"{gid}.json")
        lines = sum(1 for c in story["chapters"] for l in c["lines"] if l["k"] in ("say", "card") and not l.get("title"))
        catalog.append({
            "id": gid, "title": story["title"], "kind": story.get("kind", "other"),
            "chapters": len(story["chapters"]), "lines": lines,
            "cover": story["assets"]["bg"].get(story.get("cover") or ""),
            "added": item.get("added"),
        })
    for f in os.listdir(os.path.join(SITE, "data", "events")):
        if f.endswith(".json") and f not in live:
            os.remove(os.path.join(SITE, "data", "events", f))
    write_json(os.path.join(SITE, "data", "catalog.json"),
               {"generated": datetime.date.today().isoformat(), "events": catalog}, compact=True)
    print(f"site data: {len(catalog)} published events")


def cmd_list(data_dir, words):
    mg = read_json(os.path.join(data_dir, "memory_group.json"), {})
    kinds = {(1, 0): "main", (2, 1): "major", (2, 2): "minor", (2, 3): "festive", (3, 0): "character"}
    pub = {e["id"] for e in published()}
    for g in sorted((v for v in mg.values() if isinstance(v, dict)), key=lambda g: g["id"]):
        title = g["title"].strip()
        if words and not all(w.lower() in title.lower() for w in words):
            continue
        mark = "*" if g["id"] in pub else " "
        print(f"{mark} {g['id']:>5}  {kinds.get((g['type'], g['subtype']), 'other'):9s} {len(g['memories']):3d} ch  {title}")


def main(argv):
    update = "--update" in argv
    args = [a for a in argv if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    cmd = args[0]
    if cmd == "refresh":
        refresh()
        return 0
    data_dir = sources(update)
    if cmd == "list":
        cmd_list(data_dir, args[1:])
        return 0
    if cmd in ("add", "rebuild", "remove") and len(args) == 2 and args[1].isdigit():
        gid = int(args[1])
        cfg = read_json(EVENTS_CFG, {"events": []})
        ids = [e["id"] for e in cfg["events"]]
        if cmd == "remove":
            cfg["events"] = [e for e in cfg["events"] if e["id"] != gid]
            write_json(EVENTS_CFG, cfg)
            refresh()
            return 0
        if cmd == "rebuild" and gid not in ids:
            print(f"{gid} is not published; use add")
            return 1
        story = build_story(gid, data_dir)
        build_assets(gid, story)
        if gid not in ids:
            cfg["events"].append({"id": gid, "added": datetime.date.today().isoformat()})
            write_json(EVENTS_CFG, cfg)
        refresh()
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
