import re
from dataclasses import asdict, dataclass
from typing import Protocol

from .curriculum import BANK

STATES = [
    "ONBOARDING",
    "DIAGNOSTIC",
    "PLANNING",
    "EXPLAINING",
    "GUIDED_PRACTICE",
    "INDEPENDENT_PRACTICE",
    "REVIEW",
    "SESSION_SUMMARY",
]
ACTIONS = ["WAIT", "ASK", "HINT", "EXPLAIN", "CHALLENGE", "CORRECT", "REVIEW", "ADVANCE"]


@dataclass
class Decision:
    action: str
    instruction: str
    reason: str
    role: str = "fast"
    auto: bool = False

    def json(self):
        return asdict(self)


class Policy(Protocol):
    def decide(self, state: dict, text: str, event: str, result: bool | None) -> Decision: ...


def extract_profile(profile, text):
    p = dict(profile)
    for board in ["Edexcel", "AQA", "OCR", "CIE", "CAIE"]:
        if board.lower() in text.lower():
            p["exam_board"] = board
    current = re.search(r"(?:现在|目前|只有|当前|current(?:ly)?)[^A-Fa-f\n]{0,10}([A-Fa-f][*]?)", text)
    target = re.search(r"(?:冲|目标|达到|到|want|target|aim(?:ing)?(?: for)?)[^A-Fa-f\n]{0,8}([A-Fa-f][*]?)", text)
    if current:
        p["current_grade"] = current[1].upper()
    if target:
        p["target_grade"] = target[1].upper()
    date = re.search(
        r"\d{4}-\d{2}-\d{2}|(?:一个|一|两|\d+)\s*(?:个?月|周|天)|\d+\s*(?:days?|weeks?|months?)", text, re.I
    )
    if date:
        p["exam_time_reported"] = date[0]
    if text and not p.get("goal"):
        p["goal"] = text[:500]
    return p


class TeachingPolicy:
    def decide(self, s, text="", event="message", result=None):
        state = s["state"]
        item = BANK[s.get("topic_index", 0)]
        if event == "end":
            s["state"] = "SESSION_SUMMARY"
            s["paused"] = False
            return Decision("REVIEW", "今天先到这里。学习记录已保存；下次从需要巩固的步骤继续。", "student_end")
        if event == "pause":
            s["paused"] = True
            return Decision("WAIT", "好，先休息。你的白板和进度已经保存。准备好了再恢复。", "student_pause")
        if event == "resume":
            s["paused"] = False
            return Decision(
                "ASK",
                "回来了。我们接着刚才这道题，你也可以先让我重新解释。",
                "student_resume",
                auto=state in ["PLANNING", "EXPLAINING"],
            )
        if s.get("paused"):
            return Decision("WAIT", "课堂已暂停。点击恢复后再继续。", "paused")
        if state == "SESSION_SUMMARY":
            return Decision("WAIT", "这节课已结束。可以创建下一节课继续。", "ended")
        if event == "voice":
            return Decision(
                "EXPLAIN", "先回答学生刚说的问题，随后从实际听过的句段自然衔接当前题。"
                "不机械重播旧回答；未播放内容不算已教。若涉及负号、指数、变量、分子分母或导数/倒数"
                "的歧义，先简短确认原意，保留英文术语，不静默改写数学观点。口头答案不作为评分证据。",
                "voice_question", "reasoning",
            )
        if event == "reexplain":
            s["assisted"] = True
            return Decision("EXPLAIN", item["explanation"] + " " + item["hint"], "student_reexplain", "reasoning")
        if event == "topic":
            s["assisted"] = True
            s["detour"] = text
            return Decision(
                "EXPLAIN",
                "回应学生的新问题，不评分；保留原题，允许随时回到原课程。问题：" + text,
                "student_detour",
                "reasoning",
            )
        if event == "hint":
            s["assisted"] = True
            return Decision("HINT", item["hint"], "student_hint")
        if event == "board":
            obs = s.get("observation", {})
            if obs.get("confidence", 0) < 0.8 or not obs.get("step_complete"):
                return Decision("WAIT", "白板尚不足以可靠判断完整步骤，保持安静。", "uncertain_observation")
            s["assisted"] = True
            return Decision(
                "ASK",
                "根据可见步骤提一个简短检查问题，不直接宣判错误。观察：" + str(obs.get("visible_text", ""))[:800],
                "completed_step",
                "reasoning",
            )
        if state == "ONBOARDING":
            p = s["profile"] = extract_profile(s.get("profile", {}), text)
            for key, question in [
                ("exam_board", "你考的是 Edexcel、AQA，还是其他考试局？"),
                ("target_grade", "你这次希望达到什么成绩？"),
                ("exam_time_reported", "距离考试大约还有多久？"),
            ]:
                if not p.get(key):
                    return Decision("ASK", question, "missing_" + key)
            s["state"] = "DIAGNOSTIC"
            s["topic_index"] = 0
            s["assisted"] = False
            return Decision(
                "ASK",
                "我先看几个具体步骤，再判断怎么安排；不能保证目标成绩。这次先诊断三个求导知识点。"
                + BANK[0]["question"],
                "start_diagnostic",
            )
        if state == "DIAGNOSTIC":
            if result is None:
                return Decision(
                    "ASK",
                    "先给出这题的导数表达式，例如 dy/dx=…；不会也可以说“不会”。" + item["question"],
                    "need_answer",
                )
            s.setdefault("diagnostic", []).append({"topic": item["topic"], "correct": result})
            if s["topic_index"] < len(BANK) - 1:
                s["topic_index"] += 1
                s["assisted"] = False
                return Decision(
                    "ASK",
                    ("这一步成立。" if result else "记下了，我们稍后回来处理。") + BANK[s["topic_index"]]["question"],
                    "next_diagnostic",
                )
            s["topic_index"] = next((i for i, r in enumerate(s["diagnostic"]) if not r["correct"]), 0)
            s["state"] = "PLANNING"
            return Decision("ADVANCE", "诊断完成。我会先安排一个有针对性的短练习。", "diagnostic_complete", auto=True)
        if state == "PLANNING":
            s["state"] = "EXPLAINING"
            s["plan"] = [item["title"] + "：讲解 → 引导练习 → 独立练习 → 延迟复习"]
            return Decision(
                "EXPLAIN",
                "本节先练"
                + item["title"]
                + "，再用一道独立题检查迁移。计划根据刚才的题目证据安排，不代表完整能力评估。",
                "plan_ready",
                "reasoning",
                True,
            )
        if state == "EXPLAINING":
            s["state"] = "GUIDED_PRACTICE"
            s["assisted"] = True
            return Decision("EXPLAIN", item["explanation"] + "\n现在你来试：" + item["practice"], "begin_guided")
        if state in ["GUIDED_PRACTICE", "INDEPENDENT_PRACTICE"]:
            if result is None:
                return Decision(
                    "ASK",
                    "可以在白板上推导，再把最终导数写到消息里，我会进行精确多项式校验。"
                    + (item["practice"] if state == "GUIDED_PRACTICE" else item["independent"]),
                    "need_verifiable_answer",
                )
            if not result:
                s["assisted"] = True
                return Decision("HINT", item["hint"] + " 再检查一次，把修正后的导数发给我。", "incorrect_answer")
            if state == "GUIDED_PRACTICE":
                s["state"] = "INDEPENDENT_PRACTICE"
                s["assisted"] = False
                return Decision(
                    "CHALLENGE", "这次导数成立。换一道，先独立完成：" + item["independent"], "guided_passed"
                )
            s["state"] = "REVIEW"
            return Decision(
                "REVIEW",
                "结果成立。今天的关键是" + item["title"] + "。你可以用自己的话解释一下为什么这样求导；复习记录已安排。",
                "independent_passed",
            )
        if state == "REVIEW":
            s["state"] = "SESSION_SUMMARY"
            return Decision(
                "REVIEW", "这节课先收在这里。记录会保留这次的正确率、用过的提示与下一次复习内容。", "review_complete"
            )
        return Decision("WAIT", "先想一想，需要时可以叫我。", "wait")


class BaselinePolicy:
    def decide(self, s, text="", event="message", result=None):
        if event in ["end", "pause", "resume"] or s.get("paused") or s["state"] == "SESSION_SUMMARY":
            return TeachingPolicy().decide(s, text, event, result)
        return Decision("EXPLAIN", "根据用户消息自然回应。不要报告未测量的掌握程度。", "baseline", "fast")
