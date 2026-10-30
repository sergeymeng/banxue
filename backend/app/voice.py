"""Provider-neutral voice contracts and bounded classroom helpers. No raw audio persistence."""
import re
from dataclasses import dataclass
from typing import AsyncIterator, Protocol


@dataclass
class Transcript:
    text: str
    final: bool
    sentence_id: int = 0


class ASR(Protocol):
    def transcribe(self, audio: AsyncIterator[bytes], terms: list[str]) -> AsyncIterator[Transcript]: ...


class TTS(Protocol):
    def speak(self, text: str) -> AsyncIterator[bytes]: ...


class StreamingLLM(Protocol):
    async def complete(self, db, lesson_id, role, messages, *, image=None): ...


class BoardActions(Protocol):
    """Future hook only: current product has no autonomous board action queue."""
    async def pause(self, turn_id: str) -> None: ...
    async def cancel(self, turn_id: str) -> None: ...


def classify_interruption(text: str) -> str:
    clean = re.sub(r"[\s，。！？,.!?、]", "", text).lower()
    if not clean:
        return "noise"
    if clean in {"嗯", "嗯嗯", "对", "好的", "好", "是", "ok", "yes", "uhhuh"}:
        return "ack"
    # Never infer noise from arbitrary short words, nor correct ASR mathematical claims.
    return "question"


def chapter_terms(topic: int) -> list[str]:
    return ["函数", "导数", "倒数", "derivative"] + {
        0: ["链式法则", "chain rule", "内层函数", "外层函数"],
        1: ["乘积法则", "product rule"],
        2: ["幂函数", "指数", "power rule"],
    }.get(topic, [])


def spoken_math(text: str) -> str:
    """Conservative oral form; complex/unhandled TeX is referred to on screen."""
    text = re.sub(r"\\frac\{([^{}]+)\}\{([^{}]+)\}", r"\2分之\1", text)
    text = re.sub(r"([a-zA-Z0-9)])\^\{?(-?\d+)\}?", r"\1的\2次方", text)
    for a, b in {r"\times": "乘以", r"\cdot": "乘以", r"\div": "除以", r"\leq": "小于等于",
                 r"\geq": "大于等于", "=": "等于", "−": "减", "+": "加"}.items():
        text = text.replace(a, b)
    text = re.sub(r"(?<=[a-zA-Z0-9)])\s*-", "减", text)
    text = re.sub(r"-(?=\d|[a-zA-Z])", "负", text)
    # Never speak unknown LaTeX control sequences literally.
    if re.search(r"\\[a-zA-Z]+|\^", text):
        return "请看屏幕上的这个公式。"
    return re.sub(r"[$`{}\\]|\*\*|#{1,6}", "", text).strip()


class SentenceBuffer:
    def __init__(self):
        self.pending = ""

    def feed(self, delta: str, final=False) -> list[str]:
        self.pending += delta
        result = []
        # Avoid splitting a decimal or cutting LaTeX control words.
        while match := re.search(r"[。！？!?；;\n]|\.(?=\s)", self.pending):
            end = match.end()
            result.append(self.pending[:end])
            self.pending = self.pending[end:]
        if len(self.pending) > 240 or final:
            if self.pending.strip():
                result.append(self.pending)
            self.pending = ""
        return [s.strip() for s in result if s.strip()]


def needs_math_confirmation(text: str) -> bool:
    # ASR supplies no calibrated mathematical confidence. Ask rather than silently normalize
    # a high-impact spoken symbol or the homophones 导数/倒数 in an answer.
    return bool(re.search(r"负|减号|分母|分子|次方|指数|倒数|[a-zA-Z]\s*[-^/]|\b(?:negative|denominator|numerator|squared|cubed|power)\b", text, re.I))


def whiteboard_text(board: dict) -> list[dict]:
    """Extract only existing typed text; strokes/images are NOT recognized here."""
    def rich_text(node, depth=0):
        if depth > 6 or not isinstance(node, dict):
            return ""
        value = str(node.get("text", ""))[:200]
        for child in node.get("content", [])[:20]:
            value += rich_text(child, depth + 1)
            if len(value) >= 200:
                break
        return value[:200]
    store = board.get("store", board.get("document", {}).get("store", {}))
    result = []
    if isinstance(store, dict):
        for shape in list(store.values())[:300]:
            if not isinstance(shape, dict):
                continue
            props = shape.get("props", {})
            text = str(props.get("text") or rich_text(props.get("richText")) or "")[:200]
            if text:
                result.append({"text": text, "source": "teacher_note" if shape.get("meta", {}).get("author") == "teacher" else "typed_board_text"})
    return result[:4]
