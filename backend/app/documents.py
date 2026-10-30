import io
import re

from pypdf import PdfReader
from sqlalchemy import text


def parse_pdf(content: bytes):
    if len(content) > 20 * 1024 * 1024 or not content.startswith(b"%PDF-"):
        raise ValueError("只接受不超过 20MB 的 PDF。")
    reader = PdfReader(io.BytesIO(content))
    if reader.is_encrypted:
        raise ValueError("暂不支持加密 PDF，请先解密。")
    if len(reader.pages) > 300:
        raise ValueError("MVP 每个 PDF 最多 300 页，请拆分后导入。")
    chunks, unreadable, headings = [], [], []
    for page_number, page in enumerate(reader.pages, 1):
        if len(page.get_contents().get_data() if page.get_contents() else b"") > 8_000_000:
            raise ValueError("单页解压后内容过大，请压缩或拆分 PDF。")
        value = (page.extract_text() or "").strip()[:80000]
        if len(value) < 25:
            unreadable.append(page_number)
        heading = next(
            (
                line[:160]
                for line in value.splitlines()
                if re.match(r"^(Chapter|Unit|Section|第.{1,8}章|\d+[. ]+)", line, re.I)
            ),
            "",
        )
        if heading:
            headings.append({"page": page_number, "heading": heading})
        for start in range(0, len(value), 1000):
            chunks.append({"page": page_number, "heading": heading, "content": value[start : start + 1200]})
    return {
        "pages": len(reader.pages),
        "unreadable_pages": unreadable,
        "headings": headings,
        "status": "OCR_REQUIRED" if unreadable else "TEXT_EXTRACTED",
        "chunks": chunks,
    }


def index_chunks(db, document_id, teacher_id, chunks):
    for c in chunks:
        db.execute(
            text("INSERT INTO chunks(document_id,teacher_id,page,heading,content) VALUES (:d,:t,:p,:h,:c)"),
            {"d": document_id, "t": teacher_id, "p": c["page"], "h": c["heading"], "c": c["content"]},
        )


def retrieve(db, teacher_id, query, limit=3):
    terms = re.findall(r"[a-zA-Z0-9]{2,}|[\u4e00-\u9fff]+", query)[:15]
    if not terms:
        return []
    # Quoted tokens prevent FTS operator injection. Chinese unigram matching is not yet implemented.
    match = " OR ".join('"' + t.replace('"', "") + '"' for t in terms)
    rows = db.execute(
        text(
            "SELECT document_id,page,heading,content,bm25(chunks) AS score FROM chunks WHERE chunks MATCH :q AND teacher_id=:t ORDER BY score LIMIT :n"
        ),
        {"q": match, "t": teacher_id, "n": min(limit, 3)},
    ).mappings()
    return [dict(r) for r in rows]
