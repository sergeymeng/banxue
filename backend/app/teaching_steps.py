"""Audited scaffolds for the existing bank; no model-generated grading rules."""

from .curriculum import BANK, grade

# Each tuple is (prompt, expected polynomial, local explanation).
STEPS = {
    (0, "DIAGNOSTIC"): [
        ("令 u=3x+1，du/dx 是多少？", "3", "3x 的导数是 3，常数 1 的导数是 0。"),
        ("外层是 u²，dy/du 是多少？请用 x 表示。", "2*(3*x+1)", "平方求导是 2u；这里 u=3x+1。"),
    ],
    (0, "GUIDED_PRACTICE"): [
        ("令 u=2x+3，先求 du/dx。", "2", "2x 的导数是 2，常数 3 的导数是 0。"),
        ("外层是 u³，dy/du 是多少？请用 x 表示。", "3*(2*x+3)^2", "立方求导是 3u²；这里 u=2x+3。"),
    ],
    (0, "INDEPENDENT_PRACTICE"): [
        ("令 u=x²+1，先求 du/dx。", "2*x", "x² 的导数是 2x，常数项导数是 0。"),
        ("外层是 u³，dy/du 是多少？请用 x 表示。", "3*(x^2+1)^2", "先对 u 求导，得到 3u²。"),
    ],
    (1, "DIAGNOSTIC"): [
        ("先展开 x²(x+1)，得到什么？", "x^3+x^2", "把 x² 分别乘进括号里的两项。"),
    ],
    (1, "GUIDED_PRACTICE"): [
        ("先展开 x²(2x+1)，得到什么？", "2*x^3+x^2", "x² 分别乘 2x 和 1，指数相加。"),
    ],
    (1, "INDEPENDENT_PRACTICE"): [
        ("先展开 (x²+1)(x+2)，得到什么？", "x^3+2*x^2+x+2", "第一组的每一项都要乘第二组的每一项。"),
    ],
    (2, "DIAGNOSTIC"): [
        ("先只求 4x³ 的导数。", "12*x^2", "系数乘指数，指数减一。"),
        ("再求 −2x² 的导数。", "-4*x", "负号保留，系数 −2 乘指数 2。"),
    ],
    (2, "GUIDED_PRACTICE"): [
        ("先只求 3x⁴ 的导数。", "12*x^3", "系数 3 乘指数 4，指数减一。"),
        ("再求 −5x² 的导数。", "-10*x", "负号保留，系数 −5 乘指数 2。"),
    ],
    (2, "INDEPENDENT_PRACTICE"): [
        ("先只求 2x⁵ 的导数。", "10*x^4", "系数 2 乘指数 5，指数减一。"),
        ("再求 −3x³ 的导数。", "-9*x^2", "负号保留，系数 −3 乘指数 3。"),
    ],
}


def exercise_key(s):
    return f"{s.get('topic_index', 0)}:{s['state']}"


def flow(s):
    key = exercise_key(s)
    if (s.get("exercise_flow") or {}).get("key") != key:
        s["exercise_flow"] = {"key": key, "step": 0, "hints": 0, "scaffold": False}
    return s["exercise_flow"]


def current_step(s):
    steps = STEPS.get((s.get("topic_index", 0), s["state"]), [])
    index = flow(s)["step"]
    if index < len(steps):
        return steps[index]
    explanation = ["把外层导数乘以内层导数。", "展开后逐项求导，再把各项相加。", "合并各项的导数；常数项的导数是 0。"]
    return ("把这些步骤合起来，写出完整的 dy/dx。", None, explanation[s.get("topic_index", 0)])


def question(s):
    item = BANK[s.get("topic_index", 0)]
    return item.get(
        {"DIAGNOSTIC": "question", "GUIDED_PRACTICE": "practice", "INDEPENDENT_PRACTICE": "independent"}.get(
            s["state"], "question"
        )
    )


def next_prompt(s):
    """Do not accidentally give an unrecorded hint on an independent task."""
    return current_step(s)[0] if flow(s)["scaffold"] else question(s)


def interpret_answer(s, text, expected):
    """Only typed, parseable polynomials reach this deterministic checker."""
    f = flow(s)
    label = text.split("=", 1)[0].strip().lower() if "=" in text else ""
    step_label = label in {"du/dx", "dy/du"}
    if step_label and (s.get("topic_index", 0) != 0 or f["step"] != {"du/dx": 0, "dy/du": 1}[label]):
        return None
    final = grade(text, expected)
    if final is True and not step_label:
        return {"scope": "final", "correct": True}
    prompt, step_answer, _ = current_step(s)
    step_result = grade(text, step_answer) if step_answer else None
    explicit_final = text.lower().strip().startswith(("dy/dx", "y'", "y′", "最终"))
    if step_answer and not explicit_final and (step_result is True or f["scaffold"] or step_label):
        if step_result is not None:
            return {"scope": "step", "correct": step_result, "step": f["step"], "prompt": prompt}
    return {"scope": "final", "correct": final} if final is not None else None


def conversational_event(text):
    value = text.strip().lower()
    commands = {
        "pause": {"休息", "暂停", "pause", "先休息"},
        "resume": {"继续", "恢复", "resume"},
        "end": {"结束", "结束课程", "end", "下课"},
        "reexplain": {"重讲", "再解释一次", "重新解释", "没懂", "没听懂", "听不懂"},
        "hint": {"提示", "给我提示", "hint", "不会", "不知道", "不知道怎么做", "i don't know"},
        "return": {"回到原题", "继续原题"},
        "next": {"换题", "下一题", "换一道"},
    }
    for event, phrases in commands.items():
        if value in phrases:
            return event
    if any(word in value for word in ("你错了", "你说错", "写错了", "不是这个", "我说的是", "纠正", "you are wrong")):
        return "correction"
    if any(word in value for word in ("?", "？", "为什么", "怎么", "为何", "what ", "why ", "how ")):
        return "question"
    return "message"
