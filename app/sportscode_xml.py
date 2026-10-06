"""Timeline import/export in the widely used ALL_INSTANCES XML format (Sportscode-compatible)."""
import xml.etree.ElementTree as ET


def export_xml(match, tags, players, template) -> str:
    pl = {p["id"]: p for p in players}
    team_name = {"A": match["team_a"], "B": match["team_b"]}
    root = ET.Element("file")
    inst_root = ET.SubElement(root, "ALL_INSTANCES")
    for i, t in enumerate(tags, 1):
        if t.get("end") is None:
            continue
        inst = ET.SubElement(inst_root, "instance")
        ET.SubElement(inst, "ID").text = str(i)
        ET.SubElement(inst, "start").text = f"{t['start']:.2f}"
        ET.SubElement(inst, "end").text = f"{t['end']:.2f}"
        ET.SubElement(inst, "code").text = t["code"]
        labels = []
        if t.get("team") in team_name:
            labels.append(("Team", team_name[t["team"]]))
        p = pl.get(t.get("player_id"))
        if p:
            labels.append(("Player", f"{p['number']} {p['name']}".strip()))
        labels += [(l["grp"], l["label"]) for l in t["labels"]]
        for grp, text in labels:
            lab = ET.SubElement(inst, "label")
            ET.SubElement(lab, "group").text = grp
            ET.SubElement(lab, "text").text = text
        if t.get("note"):
            ET.SubElement(inst, "free_text").text = t["note"]
        if t.get("x") is not None:
            ET.SubElement(inst, "pos_x").text = f"{t['x']:.2f}"
            ET.SubElement(inst, "pos_y").text = f"{t['y']:.2f}"
            if t.get("x2") is not None:
                ET.SubElement(inst, "pos_x2").text = f"{t['x2']:.2f}"
                ET.SubElement(inst, "pos_y2").text = f"{t['y2']:.2f}"
    rows = ET.SubElement(root, "ROWS")
    colors = {b["code"]: b["color"] for b in (template or {}).get("buttons", [])}
    for code in dict.fromkeys(t["code"] for t in tags):
        r = ET.SubElement(rows, "row")
        ET.SubElement(r, "code").text = code
        hexc = (colors.get(code) or "#94a3b8").lstrip("#")
        for k, ch in zip("RGB", (hexc[0:2], hexc[2:4], hexc[4:6])):
            ET.SubElement(r, k).text = str(int(ch, 16) * 257)  # Sportscode uses 16-bit colour
    ET.indent(root)
    return '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(root, encoding="unicode")


def parse_xml(text, match, players, descriptors):
    """Return tag dicts (with labels) ready to insert. Team comes from a Team label or a code prefix."""
    root = ET.fromstring(text.encode("utf-8") if isinstance(text, str) else text)
    names = {match["team_a"].lower(): "A", match["team_b"].lower(): "B", "team a": "A", "team b": "B"}
    by_label = {(f"{p['number']} {p['name']}".strip()).lower(): p["id"] for p in players}
    outcome = {(d["grp"].lower(), d["label"].lower()): d["outcome"] for d in descriptors}
    out = []
    for inst in root.iter("instance"):
        try:
            start = float(inst.findtext("start", "0"))
            end = float(inst.findtext("end", "0"))
        except ValueError:
            continue
        code = (inst.findtext("code") or "").strip()
        if not code:
            continue
        team, player_id, labels = None, None, []
        for lab in inst.findall("label"):
            grp = (lab.findtext("group") or "").strip()
            txt = (lab.findtext("text") or "").strip()
            if not txt:
                continue
            if grp.lower() == "team" and txt.lower() in names:
                team = names[txt.lower()]
            elif grp.lower() == "player" and txt.lower() in by_label:
                player_id = by_label[txt.lower()]
            else:
                g = grp or "Label"
                labels.append({"grp": g, "label": txt, "outcome": outcome.get((g.lower(), txt.lower()))})
        if team is None:  # e.g. "Barcelona Shot"
            for nm, k in names.items():
                if code.lower().startswith(nm + " "):
                    team, code = k, code[len(nm) + 1:].strip()
                    break

        def num(tag):
            v = inst.findtext(tag)
            try:
                return float(v) if v is not None else None
            except ValueError:
                return None

        out.append({"code": code, "team": team, "start": start, "end": max(end, start), "player_id": player_id,
                    "note": inst.findtext("free_text") or "", "labels": labels,
                    "x": num("pos_x"), "y": num("pos_y"), "x2": num("pos_x2"), "y2": num("pos_y2")})
    return out
