"""Turn one Azur Lane story group (from the game's Memories tables) into
compact reader data.

usage: python3 -I build_event.py <AzurLaneData EN dir with *.json> <group_id> <out.json> [overrides.json]

overrides.json (optional, per event): {"map_bg": {"<game map bg name>": "<AzurAssets bg name>"}}
overrides "battle_scene": {"bg", "bgm"} backdrop + music for in-battle dialogue (story mode 2) with no background;
  "story_scene": {"<story id>": {"bg", "bgm"}} the same for one story.
Chapters that open without a background are cutscenes over the battle map; they get
their stage's map background (stage found via the game's stage and map tables).

Reads: story.json, memory_group.json, memory_template.json,
       ship_skin_template.json, ship_data_statistics.json, name_code.json

Output shape (all keys short to keep the file small):
{
  "id", "title",
  "chapters": [{"id", "title", "lines": [Line...]}],
  "actors": {"<actor id>": {"name", "paint"}},
  "need": {"bg": [...], "bgm": [...], "paint": [...], "faces": {"paint": ["1","3"]}}
}
Line kinds:
  {"k":"card", "t":[text...], ...scene}            full-screen narration / title card
  {"k":"say",  "w":speaker|null, "a":actor|null, "e":expr|null, "t":text, ...scene}
Scene keys on any line: bg, bgm, stop (stop music), old (flashback tint),
  black (black screen), shake, flash, noise, opts [{t,f}], of (option flag), c (name colour),
  se (sound effect, e.g. "battle-boom2"), act (character motion: [{type: shake|move, x, y, dur, delay, n}])
Cards also carry at (the game's aside type: 3 = location caption, 1 = monologue) and title (chapter opener).
Staging (older events): sd (0 = left, 1 = right; absent = centre), ho (hide the other side),
  pfo (side whose painting fades out), sub ([{a, e, flip, left}] extra characters on screen),
  anon (speaker's name hidden), fx ([[effect name, on]]).
Chapters carry lab, a short label from the unlock condition (Day 3, A1 / C1, Part 2).
"cover" names the event's most-used scene background, for the event's home screen.
Text keeps {playername} and {tb} for the reader to fill in; {namecode:N} is resolved here.
"""
import json
import os
import re
import sys

SRC, GID, OUT = sys.argv[1], int(sys.argv[2]), sys.argv[3]
OVR = json.load(open(sys.argv[4], encoding="utf-8")) if len(sys.argv) > 4 else {}


def load(name):
    with open(os.path.join(SRC, name + ".json"), encoding="utf-8") as fh:
        return json.load(fh)


def rows(d):
    return [v for v in (d.values() if isinstance(d, dict) else d) if isinstance(v, dict)]


story = load("story")
skeys = {k.lower(): k for k in story}
groups = {g["id"]: g for g in rows(load("memory_group"))}
mems = {m["id"]: m for m in rows(load("memory_template"))}
skins = {str(s["id"]): s for s in rows(load("ship_skin_template")) if "id" in s}
stats = load("ship_data_statistics")
namecode = {str(n["id"]): n["name"] for n in rows(load("name_code"))}

NC = re.compile(r"\{namecode:(\d+)(?::[^}]*)?\}")


def resolve_codes(text):
    return NC.sub(lambda m: namecode.get(m.group(1), m.group(0)), text or "")


def ship_name(actor):
    skin = skins.get(str(actor))
    if not skin:
        return None
    group = skin.get("ship_group")
    if isinstance(group, int) and group > 0:
        for star in range(1, 7):
            row = stats.get(str(group * 10 + star))
            if row and row.get("name"):
                return resolve_codes(row["name"]).strip()
    return resolve_codes(skin.get("name", "")).strip() or None


def paint_of(actor):
    skin = skins.get(str(actor))
    return (skin or {}).get("painting") or None


group = groups[GID]
KINDS = {(1, 0): "main", (2, 1): "major", (2, 2): "minor", (2, 3): "festive", (3, 0): "character"}
out = {"id": GID, "title": resolve_codes(group["title"]).strip(),
       "kind": KINDS.get((group.get("type"), group.get("subtype")), "other"), "chapters": [], "actors": {}}
need_bg, need_bgm, need_paint, need_faces, need_se = set(), set(), set(), {}, set()
bg_use = {}


STAGE = re.compile(r"\b(?:EP?S?-?\d+(?:-\d+)?|EX-\d+|SP-?\d+|[A-D]\d)\b")


def chapter_label(cond):
    m = re.search(r"Day\s*(\d+)", cond, re.I)
    if m:
        return f"Day {m.group(1)}"
    codes = list(dict.fromkeys(STAGE.findall(cond)))
    if codes:
        return " / ".join(codes)
    m = re.search(r"\s[-–]\s([^\"”]+)[\"”]", cond)
    return m.group(1).strip() if m else ""


def add_art(actor, expr=None):
    """Register an actor's painting (and an expression) as needed; return the actor key or None."""
    p = paint_of(actor)
    if not p:
        return None
    key = str(actor)
    out["actors"].setdefault(key, {"name": ship_name(actor), "paint": p.lower()})
    need_paint.add(p.lower())
    if expr is not None:
        need_faces.setdefault(p.lower(), set()).add(str(expr))
    return key


def scene(s, line):
    bg = s.get("bgName")
    if bg:
        line["bg"] = bg.split("/")[-1].lower()
        need_bg.add(line["bg"])
    if s.get("bgm"):
        line["bgm"] = s["bgm"].lower()
        need_bgm.add(line["bgm"])
    if s.get("stopbgm"):
        line["stop"] = 1
    if s.get("oldPhoto"):
        line["old"] = 1
    if s.get("blackBg"):
        line["black"] = 1
    if s.get("dialogShake") or s.get("shakeTime"):
        line["shake"] = 1
    if s.get("flashin") or s.get("flashN"):
        line["flash"] = 1
    if s.get("paintingNoise"):
        line["noise"] = 1
    if s.get("options"):
        line["opts"] = [{"t": resolve_codes(o.get("content", "")), "f": o.get("flag")} for o in s["options"]]
    if s.get("optionFlag") is not None:
        line["of"] = s["optionFlag"]
    if s.get("nameColor"):
        line["c"] = s["nameColor"][:7]
    ev = s.get("soundeffect")
    if isinstance(ev, str) and ev.startswith("event:/"):
        parts = ev[len("event:/"):].strip(",").split("/")
        if len(parts) == 2:
            line["se"] = f"{parts[0]}-{parts[1]}".lower()
            need_se.add(line["se"])
    acts = []
    for a in s.get("action") or []:
        if isinstance(a, dict) and a.get("type") in ("shake", "move"):
            acts.append({"type": a["type"], "x": a.get("x", 0), "y": a.get("y", 0), "dur": a.get("dur", 0.3),
                         "delay": a.get("delay", 0), "n": a.get("number", 1)})
    if acts:
        line["act"] = acts
    fx = [[e["name"], bool(e.get("active", True))] for e in s.get("effects") or [] if isinstance(e, dict) and e.get("name")]
    if fx:
        line["fx"] = fx
    if s.get("side") in (0, 1):
        line["sd"] = s["side"]
    if s.get("hideOther"):
        line["ho"] = 1
    pfo = s.get("paintingFadeOut")
    if isinstance(pfo, dict) and pfo.get("side") in (0, 1):
        line["pfo"] = pfo["side"]
    return line


# stages that tell this event's stories, and the maps they sit on
def load_opt(name):
    try:
        return load(name)
    except FileNotFoundError:
        return {}


ev_story_ids = {str(mems[m]["story"]).upper() for m in group["memories"] if m in mems}
id_re = re.compile(r"\b(" + "|".join(re.escape(i) for i in sorted(ev_story_ids, key=len, reverse=True)) + r")\b") if ev_story_ids else None
stage_rows = [r for r in rows(load_opt("chapter_template"))] if id_re else []
story_stage_maps, ev_maps = {}, set()
for r in stage_rows:
    hits = set(id_re.findall(json.dumps(r))) if id_re else set()
    for h in hits:
        story_stage_maps.setdefault(h.lower(), set()).add(r.get("map"))
        ev_maps.add(r.get("map"))
maps_by_stage = {}
for r in stage_rows:
    if r.get("map") in ev_maps:
        maps_by_stage.setdefault(str(r.get("chapter_name", "")).upper(), set()).add(r.get("map"))
map_rows = {v.get("map"): v for v in rows(load_opt("expedition_data_by_map"))}


def chapter_map_bg(key, label):
    found = sorted(m for m in story_stage_maps.get(key.lower(), set()) if m)
    if not found:
        for code in STAGE.findall(label or ""):
            found += sorted(m for m in maps_by_stage.get(code.upper(), set()) if m)
    for m in found:
        name = (map_rows.get(m) or {}).get("bg")
        if name:
            name = (OVR.get("map_bg") or {}).get(name, name)
            return name.lower()
    return None


prev_bgm = None
for mid in group["memories"]:
    mem = mems.get(mid)
    if not mem:
        continue
    key = skeys.get(str(mem["story"]).lower())
    if not key:
        continue
    scripts = story[key].get("scripts") or []
    if isinstance(scripts, dict):
        scripts = list(scripts.values())
    lines = []
    for s in scripts:
        if not isinstance(s, dict):
            continue
        if s.get("sequence") or s.get("signDate"):
            texts = [resolve_codes(seq[0]) for seq in s.get("sequence") or [] if seq and isinstance(seq[0], str)]
            texts = [t for t in texts if t.strip()]
            card = {"k": "card", "t": texts}
            sign = s.get("signDate")
            if isinstance(sign, list) and sign and isinstance(sign[0], str) and sign[0].strip():
                # a place/time stamp: show it as a location caption
                card["t"] = [t.strip(" —-") for t in resolve_codes(sign[0]).split("\n") if t.strip(" —-")] + texts
                card["at"] = 3
            elif s.get("asideType") is not None:
                card["at"] = s["asideType"]
            elif not lines:
                card["title"] = 1   # the chapter's opening title card
            if not card["t"]:
                ln = scene(s, {"k": "fx"})
                if len(ln) > 1:
                    lines.append(ln)
                continue
            lines.append(scene(s, card))
            continue
        say = s.get("say")
        if not isinstance(say, str) or not say.strip():
            # pure scene change (mode 8 etc.): keep background/music changes
            ln = scene(s, {"k": "fx"})
            if len(ln) > 1:
                lines.append(ln)
            continue
        actor = s.get("actor")
        who, art = None, None
        if isinstance(actor, int) and actor > 0:
            who = ship_name(actor)
            if not s.get("hidePainting"):
                art = add_art(actor, s.get("expression"))
        elif actor == 0:
            portrait = s.get("portrait")
            who = ship_name(portrait) if isinstance(portrait, int) else "{playername}"
        if s.get("actorName"):
            who = resolve_codes(s["actorName"]).strip()
        line = {"k": "say", "w": who, "t": resolve_codes(say)}
        if s.get("withoutActorName"):
            line["w"] = None
            line["anon"] = 1
        subs = []
        for sub in s.get("subActors") or []:
            if isinstance(sub, dict) and isinstance(sub.get("actor"), int) and sub["actor"] > 0:
                k = add_art(sub["actor"], sub.get("expression"))
                if k:
                    x = (sub.get("pos") or {}).get("x", 0) or 0
                    subs.append({"a": k, "e": None if sub.get("expression") is None else str(sub["expression"]),
                                 "flip": 1 if sub.get("dir") == -1 else 0, "left": 1 if x < 0 else 0})
        if subs:
            line["sub"] = subs
        if s.get("bgName"):
            b = s["bgName"].split("/")[-1].lower()
            bg_use[b] = bg_use.get(b, 0) + 1
        if art:
            line["a"] = art
            if s.get("dir") == -1:
                line["flip"] = 1
            expr = s.get("expression")
            if expr is not None:
                line["e"] = str(expr)
        lines.append(scene(s, line))
    if not (lines and lines[0].get("title")):
        lines.insert(0, {"k": "card", "title": 1, "t": []})   # every chapter opens on a title card
    first_say = next((n for n, l in enumerate(lines) if l["k"] == "say"), len(lines))
    if story[key].get("continueBgm") and prev_bgm and not any(l.get("bgm") or l.get("stop") for l in lines[:first_say + 1]):
        lines[0]["bgm"] = prev_bgm   # music carries over from the previous chapter
    for l in lines:
        if l.get("stop"):
            prev_bgm = None
        if l.get("bgm"):
            prev_bgm = l["bgm"]
    cond = resolve_codes(mem.get("condition", "")).strip()
    first_bg = next((n for n, l in enumerate(lines) if l.get("bg")), None)
    first_say = next((n for n, l in enumerate(lines) if l["k"] == "say"), None)
    if first_say is not None and (first_bg is None or first_bg > first_say):
        # No backdrop of its own: an in-map cutscene (the battle map is the backdrop), or dialogue that plays
        # over a battle (story mode 2), which overrides can give a scene: {"battle_scene": {"bg", "bgm"}},
        # or per story {"story_scene": {"s001": {"bg", "bgm"}}}.
        bscene = (OVR.get("story_scene") or {}).get(key.lower()) or {}
        if not bscene and story[key].get("mode") == 2:
            bscene = OVR.get("battle_scene") or {}
        mbg = bscene.get("bg") or chapter_map_bg(key, chapter_label(cond))
        if mbg:
            lines[0]["bg"] = mbg
            need_bg.add(mbg)
        if bscene.get("bgm") and not any(l.get("bgm") or l.get("stop") for l in lines[:first_say + 1]):
            lines[0]["bgm"] = bscene["bgm"]
            need_bgm.add(bscene["bgm"])
            prev_bgm = bscene["bgm"]
    out["chapters"].append({
        "id": key,
        "title": resolve_codes(mem.get("title", "")).strip(),
        "sub": cond,
        "lab": chapter_label(cond),
        "lines": lines,
    })

generic = ("bg_story_task", "bg_story_room", "bg_story_school", "bg_port")
ranked = sorted(bg_use.items(), key=lambda kv: -kv[1])
out["cover"] = next((b for b, _ in ranked if not b.startswith(generic)), ranked[0][0] if ranked else None)
if OVR.get("cover"):   # overrides {"cover": "<bg name>"}: the art for the library card and story page
    out["cover"] = OVR["cover"].lower()
    need_bg.add(out["cover"])
out["need"] = {
    "se": sorted(need_se),
    "bg": sorted(need_bg),
    "bgm": sorted(need_bgm),
    "paint": sorted(need_paint),
    "faces": {k: sorted(v, key=lambda x: int(x) if x.isdigit() else 0) for k, v in sorted(need_faces.items())},
}
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

n_lines = sum(len(c["lines"]) for c in out["chapters"])
n_faces = sum(len(v) for v in need_faces.values())
print(f"{out['title']}: {len(out['chapters'])} chapters, {n_lines} lines, "
      f"{len(need_bg)} backgrounds, {len(need_bgm)} tracks, {len(need_se)} sound effects, {len(need_paint)} paintings, "
      f"{n_faces} faces; cover {out['cover']}")
