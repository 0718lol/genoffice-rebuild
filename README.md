# GenOffice Rebuild

> A local-first AI document workspace for importing, editing, reviewing, and exporting real documents.

GenOffice Rebuild is an independent reimplementation inspired by the workflow of modern AI office tools. It starts with a focused problem: make document editing feel safe when AI is involved.

The product keeps the document in the user's workspace, turns AI requests into reviewable proposals, records every accepted change, and exports a clean DOCX without overwriting the imported original.

## Why It Exists

AI should not silently replace a document. A useful writing tool needs a visible review step, a reversible history, and a reliable file boundary.

GenOffice Rebuild is built around that loop:

```text
Import or create
      |
      v
Edit in Markdown
      |
      v
Ask the local copilot
      |
      v
Review -> Apply or Reject
      |
      v
Restore a revision -> Export DOCX
```

## What Works Today

| Area | Included |
| --- | --- |
| Workspace | Project list, new documents, local JSON persistence |
| Editing | Markdown editor, word count, automatic save |
| Safety | Revision history, restore, non-destructive imports |
| AI workflow | Improve writing, summarize, continue draft, preview/apply/reject |
| Import | `.md`, `.markdown`, `.txt`, `.docx` |
| DOCX import | Headings, rich text, line breaks, ordered/unordered lists, tables, images, header/footer metadata |
| DOCX export | Word styles, numbering definitions, table borders, header rows, image sizing, headers and footers |
| Runtime | Platform-hosted web product, no API key required for the local provider |

The built-in `local-provider` is deterministic mock AI. It keeps the complete review workflow usable without credentials and is intentionally isolated behind the `/api/ai/propose` boundary for a future real provider.

## Quick Start

Requirements:

- Node.js 18+
- Python 3.10+
- No Python package installation is required for the current DOCX converter

Run locally:

```bash
cd products/genoffice-rebuild
PORT=3000 npm start
```

Open `http://localhost:3000` in a browser. The server binds to `0.0.0.0` and reads the port from `PORT`, so it also works with the ASteam product daemon.

Run the regression suite:

```bash
cd products/genoffice-rebuild
npm test
```

## Product Structure

```text
genoffice-rebuild/
├── public/
│   ├── index.html       # Workspace shell
│   ├── app.js           # Editor and workflow state
│   └── styles.css       # UI styling
├── server.js            # HTTP API, persistence, import/export orchestration
├── docx_to_markdown.py  # OOXML to Markdown converter
├── markdown_to_docx.py  # Markdown to OOXML converter
├── data/
│   ├── projects.json    # Local project metadata and revisions
│   └── assets/          # Imported document assets
└── app.toml             # ASteam product definition
```

The Node server owns HTTP, storage, downloads, and process boundaries. The Python converters own DOCX package inspection and generation. Imported originals are never modified; exported DOCX files are generated as separate downloads.

## API Surface

The current server exposes a small, explicit API:

```text
GET  /api/projects
POST /api/projects
GET  /api/projects/:id
POST /api/projects/:id/save
POST /api/projects/:id/restore
POST /api/import
POST /api/ai/propose
POST /api/projects/:id/export/docx
GET  /api/projects/:id/assets/:file
```

## Supported DOCX Boundary

This project aims for useful, inspectable conversion rather than claiming full Word compatibility. The current implementation does not promise lossless handling of complex themes, comments, tables of contents, floating images, text boxes, fields, tracked changes, or advanced pagination rules.

Those cases are intentionally kept visible as the next engineering work instead of being hidden behind a misleading "full fidelity" label.

## Roadmap

1. Add a configurable OpenAI-compatible provider while retaining the local fallback.
2. Expand golden DOCX fixtures and XML/rendered regression checks.
3. Improve complex lists, styles, page layout, and embedded media.
4. Add document search and richer editing commands.
5. Explore PDF preview, read-only sheets, and slide documents after the document workflow is stable.

## Project Principles

- Reviewable AI changes instead of silent overwrites.
- Every accepted edit should be reversible.
- File conversion should be explicit and non-destructive.
- Product behavior should remain useful without an API key.
- Rebuild the workflow and engineering boundaries, not the upstream brand, assets, or pixel-level UI.

## License and Attribution

This is an independent rebuild for compatibility and product research. It does not include the upstream enterprise boundary or copy upstream branding and visual assets. Review third-party and upstream licenses before distributing a derivative implementation.
