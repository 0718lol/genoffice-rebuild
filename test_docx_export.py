import json
import os
import subprocess
import tempfile
from zipfile import ZipFile

markdown = """# Export plan

Draft **ready** for *review* and ~~cleanup~~.

- Ship the workflow
- Verify the roundtrip

| Item | Status |
| --- | --- |
| Export | Done |

![Diagram](diagram.png)
"""

with tempfile.TemporaryDirectory() as directory:
    asset_dir = os.path.join(directory, "assets")
    os.makedirs(asset_dir, exist_ok=True)
    with open(os.path.join(asset_dir, "diagram.png"), "wb") as output:
        output.write(b"fake-png")

    source = os.path.join(directory, "doc.md")
    docx = os.path.join(directory, "export.docx")
    with open(source, "w", encoding="utf-8") as output:
        output.write(markdown)

    metadata = json.dumps({"headers": [{"text": "Confidential header"}], "footers": [{"text": "Page footer"}]})
    subprocess.run(["python3", "markdown_to_docx.py", source, asset_dir, docx, metadata], check=True, capture_output=True, text=True)

    with ZipFile(docx) as archive:
        assert "word/document.xml" in archive.namelist()
        assert "word/media/diagram.png" in archive.namelist()
        assert "word/styles.xml" in archive.namelist()
        assert "word/numbering.xml" in archive.namelist()
        assert "word/header1.xml" in archive.namelist()
        assert "word/footer1.xml" in archive.namelist()
        document_xml = archive.read("word/document.xml").decode("utf-8")
        assert "tblBorders" in document_xml and "w:numId w:val=\"1\"" in document_xml

    roundtrip = subprocess.run(
        ["python3", "docx_to_markdown.py", docx, os.path.join(directory, "roundtrip-assets"), "/api/projects/test/assets/"],
        check=True,
        capture_output=True,
        text=True,
    )
    converted = json.loads(roundtrip.stdout)
    result = converted["markdown"]
    assert "# Export plan" in result
    assert "**ready**" in result and "*review*" in result and "~~cleanup~~" in result
    assert "- Ship the workflow" in result
    assert "| Item | Status |" in result
    assert "diagram.png" in result
    print("DOCX export fixture passed")
