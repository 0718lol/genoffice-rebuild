import json
import mimetypes
import os
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def clean(value):
    return re.sub(r"[ \t\r\f\v]+", " ", value).strip()


def run_markdown(run):
    parts = []
    for node in run.iter():
        if node.tag == W + "t" or node.tag == W + "instrText":
            parts.append(node.text or "")
        elif node.tag == W + "tab":
            parts.append("\t")
        elif node.tag == W + "br":
            parts.append("\n" if node.get(W + "type") != "page" else "\n\n<!-- genoffice:page-break -->\n\n")
    value = "".join(parts).replace("|", "\\|")
    leading = re.match(r"^\s*", value).group(0)
    trailing = re.search(r"\s*$", value).group(0)
    core = value[len(leading):len(value) - len(trailing) if trailing else None]
    props = run.find(W + "rPr")
    if props is not None:
        if props.find(W + "strike") is not None:
            core = "~~" + core + "~~"
        if props.find(W + "b") is not None:
            core = "**" + core + "**"
        if props.find(W + "i") is not None:
            core = "*" + core + "*"
        if props.find(W + "vertAlign") is not None:
            align = props.find(W + "vertAlign").get(W + "val", "")
            if align == "superscript":
                core = "<sup>" + core + "</sup>"
            elif align == "subscript":
                core = "<sub>" + core + "</sub>"
    return leading + core + trailing


def paragraph_text(paragraph):
    return "".join(run_markdown(run) for run in paragraph.iter(W + "r"))


def list_info(paragraph, numbering):
    props = paragraph.find(W + "pPr")
    num_props = props.find(W + "numPr") if props is not None else None
    if num_props is None:
        return None
    num_id = num_props.find(W + "numId")
    level = num_props.find(W + "ilvl")
    if num_id is None:
        return "- "
    num_key = num_id.get(W + "val", "")
    level_key = int(level.get(W + "val", "0")) if level is not None else 0
    abstract = numbering.get("nums", {}).get(num_key, "")
    fmt = numbering.get("abstract", {}).get(abstract, {}).get(str(level_key), "bullet")
    indent = "  " * level_key
    return indent + ("1. " if fmt in {"decimal", "upperRoman", "lowerRoman", "upperLetter", "lowerLetter"} else "- ")


def paragraph_markdown(paragraph, numbering=None):
    numbering = numbering or {"nums": {}, "abstract": {}}
    value = paragraph_text(paragraph).strip()
    props = paragraph.find(W + "pPr")
    style_id = ""
    if props is not None:
        style = props.find(W + "pStyle")
        style_id = style.get(W + "val", "") if style is not None else ""
    if style_id.lower().startswith("heading"):
        level = "".join(char for char in style_id if char.isdigit()) or "2"
        return "#" * min(int(level), 6) + " " + value
    marker = list_info(paragraph, numbering)
    if marker:
        return marker + value
    return value


def cell_markdown(cell, numbering, plain=False):
    paragraphs = [paragraph_markdown(node, numbering) for node in cell.findall(W + "p")]
    value = " / ".join(item.strip() for item in paragraphs if item.strip())
    if plain:
        value = re.sub(r"\*\*|~~|(?<!\*)\*(?!\*)", "", value).replace("</sup>", "").replace("<sup>", "").replace("</sub>", "").replace("<sub>", "")
    return value.replace("|", "\\|")


def table_markdown(table, numbering):
    rows = []
    for row_index, row in enumerate(table.findall(W + "tr")):
        cells = [cell_markdown(cell, numbering, plain=row_index == 0) for cell in row.findall(W + "tc")]
        if cells:
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    output = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    output.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return "\n".join(output)


def numbering_map(archive):
    result = {"nums": {}, "abstract": {}}
    if "word/numbering.xml" not in archive.namelist():
        return result
    root = ET.fromstring(archive.read("word/numbering.xml"))
    for abstract in root.findall(W + "abstractNum"):
        abstract_id = abstract.get(W + "abstractNumId", "")
        result["abstract"][abstract_id] = {}
        for level in abstract.findall(W + "lvl"):
            level_id = level.get(W + "ilvl", "0")
            fmt = level.find(W + "numFmt")
            result["abstract"][abstract_id][level_id] = fmt.get(W + "val", "bullet") if fmt is not None else "bullet"
    for num in root.findall(W + "num"):
        num_id = num.get(W + "numId", "")
        abstract = num.find(W + "abstractNumId")
        if abstract is not None:
            result["nums"][num_id] = abstract.get(W + "val", "")
    return result


def relationships_map(archive, part="word/document.xml"):
    rel_path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    if rel_path not in archive.namelist():
        return {}
    root = ET.fromstring(archive.read(rel_path))
    return {item.get("Id"): item.get("Target", "") for item in root.findall(REL + "Relationship")}


def part_text(archive, part):
    if part not in archive.namelist():
        return ""
    root = ET.fromstring(archive.read(part))
    paragraphs = [clean(paragraph_text(node)) for node in root.iter(W + "p")]
    return "\n".join(item for item in paragraphs if item)


def convert(path, asset_dir, asset_prefix):
    os.makedirs(asset_dir, exist_ok=True)
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        relationships = relationships_map(archive)
        numbering = numbering_map(archive)
        assets = []
        for name in archive.namelist():
            if not name.startswith("word/media/"):
                continue
            filename = os.path.basename(name)
            target = os.path.join(asset_dir, filename)
            with open(target, "wb") as output:
                output.write(archive.read(name))
            assets.append({"name": filename, "url": asset_prefix + filename, "type": mimetypes.guess_type(filename)[0] or "application/octet-stream"})

        metadata = {"headers": [], "footers": []}
        for rel_id, target in relationships.items():
            if not (target.startswith("header") or target.startswith("footer")):
                continue
            part = posixpath.normpath(posixpath.join("word", target))
            text = part_text(archive, part)
            if text:
                key = "headers" if target.startswith("header") else "footers"
                metadata[key].append({"part": part, "text": text})

    body = root.find(W + "body")
    output = []
    if body is not None:
        for node in body:
            if node.tag == W + "p":
                value = paragraph_markdown(node, numbering)
                images = []
                for blip in node.iter():
                    if blip.tag.rsplit("}", 1)[-1] != "blip":
                        continue
                    embed_id = next((value for key, value in blip.attrib.items() if key.rsplit("}", 1)[-1] == "embed"), "")
                    target = relationships.get(embed_id, "")
                    filename = os.path.basename(target)
                    if filename:
                        images.append(f"![{filename}]({asset_prefix}{filename})")
                if value:
                    output.append(value)
                output.extend(images)
            elif node.tag == W + "tbl":
                value = table_markdown(node, numbering)
                if value:
                    output.append(value)

    return {"markdown": "\n\n".join(output).strip() + ("\n" if output else ""), "assets": assets, "metadata": metadata}


try:
    print(json.dumps(convert(sys.argv[1], sys.argv[2], sys.argv[3]), ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
