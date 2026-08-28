import html
import json
import mimetypes
import os
import re
import struct
import sys
import zipfile

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture"

IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
INLINE_RE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|<sup>[^<]+</sup>|<sub>[^<]+</sub>)")


def xml(value):
    return html.escape(str(value), quote=True)


def paragraph_props(style=None, list_kind=None, level=0):
    props = []
    if style:
        props.append(f'<w:pStyle w:val="{xml(style)}"/>')
    if list_kind:
        num_id = "2" if list_kind == "ordered" else "1"
        props.append(f'<w:numPr><w:ilvl w:val="{level}"/><w:numId w:val="{num_id}"/></w:numPr>')
    return f"<w:pPr>{''.join(props)}</w:pPr>" if props else ""


def run(text, bold=False, italic=False, strike=False, superscript=False, subscript=False):
    if not text:
        return ""
    values = []
    if bold:
        values.append("<w:b/>")
    if italic:
        values.append("<w:i/>")
    if strike:
        values.append("<w:strike/>")
    if superscript:
        values.append('<w:vertAlign w:val="superscript"/>')
    if subscript:
        values.append('<w:vertAlign w:val="subscript"/>')
    props = "<w:rPr>" + "".join(values) + "</w:rPr>" if values else ""
    preserve = ' xml:space="preserve"' if text[:1].isspace() or text[-1:].isspace() else ""
    return f"<w:r>{props}<w:t{preserve}>{xml(text)}</w:t></w:r>"


def inline_runs(text):
    output = []
    position = 0
    for match in INLINE_RE.finditer(text):
        output.append(run(text[position:match.start()]))
        token = match.group(0)
        if token.startswith("**"):
            output.append(run(token[2:-2], bold=True))
        elif token.startswith("~~"):
            output.append(run(token[2:-2], strike=True))
        elif token.startswith("<sup>"):
            output.append(run(token[5:-6], superscript=True))
        elif token.startswith("<sub>"):
            output.append(run(token[5:-6], subscript=True))
        else:
            output.append(run(token[1:-1], italic=True))
        position = match.end()
    output.append(run(text[position:]))
    return "".join(output) or run("")


def paragraph(text, style=None, list_kind=None, level=0):
    pieces = []
    for line in str(text).split("\n"):
        if pieces:
            pieces.append("<w:br/>")
        pieces.append(inline_runs(line))
    return f"<w:p>{paragraph_props(style, list_kind, level)}{''.join(pieces)}</w:p>"


def table(rows):
    output = [
        '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>'
        '<w:top w:val="single" w:sz="6" w:space="0" w:color="B7C0CC"/>'
        '<w:left w:val="single" w:sz="6" w:space="0" w:color="B7C0CC"/>'
        '<w:bottom w:val="single" w:sz="6" w:space="0" w:color="B7C0CC"/>'
        '<w:right w:val="single" w:sz="6" w:space="0" w:color="B7C0CC"/>'
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D8DEE6"/>'
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D8DEE6"/>'
        '</w:tblBorders><w:tblLook w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
    ]
    for row_index, row in enumerate(rows):
        output.append("<w:tr>")
        for cell in row:
            cell_props = '<w:tcPr><w:tcMar><w:top w:w="90" w:type="dxa"/><w:start w:w="110" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:end w:w="110" w:type="dxa"/></w:tcMar>'
            if row_index == 0:
                cell_props += '<w:shd w:fill="EEF2F7"/><w:tcW w:w="2200" w:type="dxa"/>'
            cell_props += "</w:tcPr>"
            content = inline_runs(cell.strip())
            if row_index == 0:
                content = f"<w:rPr><w:b/></w:rPr>{content}" if False else inline_runs(f"**{cell.strip()}**")
            output.append(f"<w:tc>{cell_props}<w:p>{content}</w:p></w:tc>")
        output.append("</w:tr>")
    output.append("</w:tbl>")
    return "".join(output)


def image_size(path):
    default = (4572000, 2743200)
    try:
        with open(path, "rb") as source:
            header = source.read(32)
        if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
            width, height = struct.unpack(">II", header[16:24])
        elif header[:2] == b"\xff\xd8":
            width = height = 0
            with open(path, "rb") as source:
                source.read(2)
                while True:
                    marker = source.read(2)
                    if len(marker) != 2:
                        break
                    size = int.from_bytes(source.read(2), "big")
                    if marker[0] == 0xFF and marker[1] in range(0xC0, 0xC4):
                        source.read(1)
                        height = int.from_bytes(source.read(2), "big")
                        width = int.from_bytes(source.read(2), "big")
                        break
                    source.seek(max(0, size - 2), 1)
        else:
            return default
        if not width or not height:
            return default
        max_width = 5800000
        scale = min(1, max_width / (width * 9525))
        return max(1, int(width * 9525 * scale)), max(1, int(height * 9525 * scale))
    except (OSError, ValueError, struct.error):
        return default


def image_paragraph(rel_id, name, path):
    cx, cy = image_size(path)
    return f'''<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="1" name="{xml(name)}"/><a:graphic><a:graphicData uri="{PIC_NS}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="{xml(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rel_id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'''


def split_table_row(line):
    return [cell.replace("\\|", "|").strip() for cell in line.strip().strip("|").split("|")]


def is_separator(line):
    cells = split_table_row(line)
    return bool(cells) and all(re.fullmatch(r"\s*:?-{3,}:?\s*", cell or "") for cell in cells)


def resolve_asset(path, asset_dir):
    name = os.path.basename(path.split("?", 1)[0].split("#", 1)[0])
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", name)
    candidate = os.path.join(asset_dir, safe)
    return safe, candidate if safe and os.path.exists(candidate) else None


def parse(markdown, asset_dir):
    blocks = []
    relationships = []
    media = []
    lines = markdown.replace("\r\n", "\n").split("\n")
    index = 0
    while index < len(lines):
        line = lines[index].rstrip()
        if not line.strip():
            index += 1
            continue
        if line.strip() == "<!-- genoffice:page-break -->":
            blocks.append("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>")
            index += 1
            continue
        if line.lstrip().startswith("|") and index + 1 < len(lines) and is_separator(lines[index + 1]):
            rows = [split_table_row(line)]
            index += 2
            while index < len(lines) and lines[index].lstrip().startswith("|"):
                rows.append(split_table_row(lines[index]))
                index += 1
            blocks.append(table(rows))
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading:
            blocks.append(paragraph(heading.group(2), f"Heading{len(heading.group(1))}"))
            index += 1
            continue
        bullet = re.match(r"^(\s*)[-*+]\s+(.+)$", line)
        ordered = re.match(r"^(\s*)\d+[.)]\s+(.+)$", line)
        if bullet or ordered:
            match = bullet or ordered
            level = len(match.group(1)) // 2
            blocks.append(paragraph(match.group(2), list_kind="ordered" if ordered else "bullet", level=level))
            index += 1
            continue
        image = IMAGE_RE.fullmatch(line.strip())
        if image:
            name, path = resolve_asset(image.group(2), asset_dir)
            if path:
                rel_id = f"rId{len(relationships) + 1}"
                target = f"media/{name}"
                relationships.append((rel_id, target, "image"))
                media.append((path, target))
                blocks.append(image_paragraph(rel_id, image.group(1) or name, path))
            else:
                blocks.append(paragraph(image.group(1) or line.strip()))
            index += 1
            continue
        quote = re.match(r"^>\s?(.*)$", line)
        if quote:
            blocks.append(paragraph(quote.group(1), "Quote"))
            index += 1
            continue
        paragraph_lines = [line]
        index += 1
        while index < len(lines) and lines[index].strip():
            if re.match(r"^(#{1,6})\s+|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^\s*\||^>\s?", lines[index]):
                break
            paragraph_lines.append(lines[index].rstrip())
            index += 1
        blocks.append(paragraph(" ".join(item.strip() for item in paragraph_lines)))
    return blocks, relationships, media


def content_types(media, has_header=False, has_footer=False):
    defaults = {"rels": "application/vnd.openxmlformats-package.relationships+xml", "xml": "application/xml"}
    for path, target in media:
        ext = os.path.splitext(target)[1].lstrip(".").lower()
        defaults[ext] = mimetypes.guess_type(path)[0] or "application/octet-stream"
    entries = [f'<Default Extension="{xml(ext)}" ContentType="{xml(kind)}"/>' for ext, kind in sorted(defaults.items())]
    entries.extend([
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>',
    ])
    if has_header:
        entries.append('<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>')
    if has_footer:
        entries.append('<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>')
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + "".join(entries) + "</Types>"


def header_footer_xml(text, kind):
    tag = "w:hdr" if kind == "header" else "w:ftr"
    paragraphs = "".join(paragraph(line) for line in str(text).splitlines() if line.strip()) or paragraph("")
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><{tag} xmlns:w="{W_NS}">{paragraphs}</{tag}>'


def document_xml(blocks, has_header=False, has_footer=False):
    references = []
    if has_header:
        references.append('<w:headerReference w:type="default" r:id="rIdHeader"/>')
    if has_footer:
        references.append('<w:footerReference w:type="default" r:id="rIdFooter"/>')
    sect = "".join(references) + '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>'
    body = "".join(blocks) or paragraph("")
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W_NS}" xmlns:r="{R_NS}" xmlns:wp="{WP_NS}" xmlns:a="{A_NS}" xmlns:pic="{PIC_NS}"><w:body>{body}<w:sectPr>{sect}</w:sectPr></w:body></w:document>'''


def document_rels(relationships, has_header=False, has_footer=False):
    entries = ['<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>', '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>']
    for rel_id, target, kind in relationships:
        rel_type = f"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}"
        entries.append(f'<Relationship Id="{rel_id}" Type="{rel_type}" Target="{xml(target)}"/>')
    if has_header:
        entries.append('<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>')
    if has_footer:
        entries.append('<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>')
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{REL_NS}">{"".join(entries)}</Relationships>'


def numbering_xml():
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="{W_NS}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>'''


def styles_xml():
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/><w:color w:val="20242B"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:jc w:val="left"/></w:pPr><w:rPr><w:i/><w:color w:val="596273"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="20242B"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="303946"/></w:rPr></w:style></w:styles>'''


def create(markdown_path, asset_dir, output_path, metadata=None):
    with open(markdown_path, "r", encoding="utf-8") as source:
        blocks, relationships, media = parse(source.read(), asset_dir)
    metadata = metadata or {}
    header_text = next((item.get("text", "") for item in metadata.get("headers", []) if item.get("text")), "")
    footer_text = next((item.get("text", "") for item in metadata.get("footers", []) if item.get("text")), "")
    has_header, has_footer = bool(header_text), bool(footer_text)
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types(media, has_header, has_footer))
        archive.writestr("_rels/.rels", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", document_xml(blocks, has_header, has_footer))
        archive.writestr("word/_rels/document.xml.rels", document_rels(relationships, has_header, has_footer))
        archive.writestr("word/styles.xml", styles_xml())
        archive.writestr("word/numbering.xml", numbering_xml())
        if has_header:
            archive.writestr("word/header1.xml", header_footer_xml(header_text, "header"))
        if has_footer:
            archive.writestr("word/footer1.xml", header_footer_xml(footer_text, "footer"))
        for path, target in media:
            archive.write(path, f"word/{target}")


try:
    metadata = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else None
    create(sys.argv[1], sys.argv[2], sys.argv[3], metadata)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
