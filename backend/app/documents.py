"""Extract plain text from uploaded files so job postings and proposals can be loaded from disk."""

from __future__ import annotations

import io
import re
from html.parser import HTMLParser
from pathlib import PurePath

SUPPORTED_EXTENSIONS = (".txt", ".md", ".markdown", ".pdf", ".docx", ".html", ".htm")


class DocumentError(ValueError):
    """The file can't be turned into text; the message is safe to show the user."""


class _TextFromHTML(HTMLParser):
    _SKIP = {"script", "style", "noscript", "template", "svg"}
    _BLOCK = {"p", "div", "br", "li", "ul", "ol", "tr", "section", "article", "header", "footer",
              "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "pre"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in self._BLOCK:
            self.parts.append("\n")
        if tag == "li":
            self.parts.append("- ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self.parts.append(data)


def _tidy(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise DocumentError("This PDF is password-protected. Remove the password or paste the text instead.")
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    except DocumentError:
        raise
    except Exception as exc:  # malformed files raise a wide variety of parser errors
        raise DocumentError("This PDF couldn't be read. It may be damaged; try pasting the text instead.") from exc


def _docx_text(data: bytes) -> str:
    from docx import Document

    try:
        document = Document(io.BytesIO(data))
    except Exception as exc:  # not a zip, missing parts, wrong content type, ...
        raise DocumentError("This Word document couldn't be read. Save it as .docx again or paste the text.") from exc

    parts = [p.text for p in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            parts.append(" | ".join(cell.text.strip() for cell in row.cells))
    return "\n".join(parts)


def _html_text(data: bytes) -> str:
    parser = _TextFromHTML()
    parser.feed(_decode(data))
    parser.close()
    return "".join(parser.parts)


def extract_text(filename: str, data: bytes) -> str:
    """Return the readable text of an uploaded document.

    Raises DocumentError for unsupported, unreadable, or empty files.
    """
    suffix = PurePath(filename or "").suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise DocumentError(
            f"Unsupported file type '{suffix or filename}'. Use one of: {', '.join(SUPPORTED_EXTENSIONS)}."
        )

    if suffix == ".pdf":
        raw = _pdf_text(data)
    elif suffix == ".docx":
        raw = _docx_text(data)
    elif suffix in (".html", ".htm"):
        raw = _html_text(data)
    else:
        raw = _decode(data)

    text = _tidy(raw)
    if not text:
        if suffix == ".pdf":
            raise DocumentError("No text found in this PDF. If it's a scan, paste the text instead.")
        raise DocumentError("This file doesn't contain any text.")
    return text
