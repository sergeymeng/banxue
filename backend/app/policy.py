import re
from dataclasses import asdict, dataclass, field
from typing import Protocol

from .curriculum import BANK
from .teaching_observations import confirmed_observation
from .teaching_steps import current_step, flow, next_prompt, question

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
    board_actions: list[dict] = field(default_factory=list)
    board_cancellations: list[str] = field(default_factory=list)

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
        if state == "SESSION_SUMMARY":
            return Decision("WAIT", "这节课已结束。可以创建下一节课继续。", "ended")
        if event in {"pause", "end", "correction", "question", "topic", "voice"}:
            for action in s.get("board_actions", []):
                if action["status"] == "proposed":
                    action["status"] = "cancelled"
        if event == "end":
            s["continuation"] = {"state": state, "topic_index": s.get("topic_index", 0),
                                 "exercise_flow": s.get("exercise_flow"), "assisted": s.get("assisted", False)}
            s["state"] = "SESSION_SUMMARY"
            s["paused"] = False
            return Decision("REVIEW", "今天先到这里。学习记录已保存；下次从需要巩固的步骤继续。", "student_end")
        if event == "pause":
            s["paused"] = True
            return Decision("WAIT", "好，先休息。你的白板和进度已经保存。准备好了再恢复。", "student_pause")
        if event == "resume":
            was_paused = s.get("paused", False)
            s["paused"] = False
            if was_paused or state not in {"PLANNING", "EXPLAINING"}:
                return Decision("ASK", "接着刚才的位置。" + (next_prompt(s) if state in
                                {"DIAGNOSTIC", "GUIDED_PRACTICE", "INDEPENDENT_PRACTICE"} else "准备好了可以说“继续”。"),
                                "student_resume")
            # Explicit student continuation may advance; playback completion alone never does.
        if s.get("paused"):
            return Decision("WAIT", "课堂已暂停。点击恢复后再继续。", "paused")
        if event == "return":
            s.pop("detour", None)
            s.pop("pending_correction", None)
            return Decision("ASK", next_prompt(s), "return_to_exercise")
        if event == "next":
            s.pop("pending_correction", None)
            s.pop("detour", None)
            s["topic_index"] = (s.get("topic_index", 0) + 1) % len(BANK)
            s["state"] = "GUIDED_PRACTICE"
            s["assisted"] = True
            flow(s)["scaffold"] = True
            return Decision("ASK", question(s) + " " + current_step(s)[0], "student_next")
        if event == "correction_detail":
            s.pop("pending_correction", None)
            s["assisted"] = True
            return Decision("ASK", "收到你的纠正。先核对原题：" + question(s),
                            "correction_received", "reasoning")
        if event == "correction":
            s["pending_correction"] = text[:500]
            return Decision("ASK", "你指出的是哪一句或哪个符号？请把正确写法发来，我先核对，再接原题。",
                            "student_correction", "reasoning")
        if event in {"question", "topic"}:
            s["detour"] = text[:500]
            s["assisted"] = True
            return Decision("EXPLAIN", "先回应这个问题，原题进度保留。", "student_detour", "reasoning")
        if event == "voice":
            return Decision(
                "EXPLAIN", "先回答学生刚说的问题，随后从实际听过的句段自然衔接当前题。"
                "不机械重播旧回答；未播放内容不算已教。若涉及负号、指数、变量、分子分母或导数/倒数"
                "的歧义，先简短确认原意，保留英文术语，不静默改写数学观点。口头答案不作为评分证据。",
                "voice_question", "reasoning",
            )
        if event in {"reexplain", "hint"}:
            s["assisted"] = True
            f = flow(s)
            f["scaffold"] = True
            f["hints"] = min(2, f["hints"] + 1)
            prompt, _, explanation = current_step(s)
            prefix = explanation + " " if event == "reexplain" or f["hints"] > 1 else ""
            return Decision("EXPLAIN" if event == "reexplain" else "HINT", prefix + prompt,
                            "student_" + event)
        if event == "board":
            obs = confirmed_observation(s)
            if obs is None:
                if not (s.get("observation") or {}).get("step_complete"):
                    return Decision("WAIT", "", "needs_confirmation")
                return Decision("ASK", "请先核对原图中的表达式，确认后我们再看这一步。", "needs_confirmation")
            if not obs["step_complete"]:
                return Decision("WAIT", "先留时间写完这一步。", "unfinished_observation")
            s["assisted"] = True
            return Decision("ASK", "根据学生已核对的有效步骤提一个具体检查问题；确认转录不代表数学正确，"
                            "不要评分或宣布掌握。", "completed_step", "reasoning")
        if not text.strip() and event == "message" and state in {
            "DIAGNOSTIC", "GUIDED_PRACTICE", "INDEPENDENT_PRACTICE"
        }:
            return Decision("WAIT", "", "waiting_for_student")
        check = s.get("answer_check")
        if check and check["scope"] == "step":
            f = flow(s)
            f["scaffold"] = True
            s["assisted"] = True
            if check["correct"]:
                f["step"] += 1
                f["hints"] = 0
                return Decision("ASK", "这一步成立。" + current_step(s)[0], "step_passed")
            return Decision("HINT", "这一步还需要检查。" + current_step(s)[2]
                            + " " + current_step(s)[0], "step_retry")
        if state == "ONBOARDING":
            p = s["profile"] = extract_profile(s.get("profile", {}), text)
            for key, profile_question in [
                ("exam_board", "你考的是 Edexcel、AQA，还是其他考试局？"),
                ("target_grade", "你这次希望达到什么成绩？"),
                ("exam_time_reported", "距离考试大约还有多久？"),
            ]:
                if not p.get(key):
                    return Decision("ASK", profile_question, "missing_" + key)
            s["state"] = "DIAGNOSTIC"
            s["topic_index"] = 0
            s["assisted"] = False
            return Decision(
                "ASK",
                "先看一道求导题。"
                + BANK[0]["question"],
                "start_diagnostic",
            )
        if state == "DIAGNOSTIC":
            if result is None:
                return Decision(
                    "ASK",
                    "写出你的下一步；需要时可以说“提示”。",
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
            flow(s)["scaffold"] = True
            return Decision("ASK", item["practice"] + " " + current_step(s)[0], "begin_guided")
        if state in ["GUIDED_PRACTICE", "INDEPENDENT_PRACTICE"]:
            if result is None:
                return Decision(
                    "ASK",
                    "这句还不能确定是哪一步。请写出表达式，或告诉我卡在哪。",
                    "need_verifiable_answer",
                )
            if not result:
                s["assisted"] = True
                flow(s)["scaffold"] = True
                return Decision("HINT", "这个表达式与这题的导数还不一致。" + current_step(s)[0],
                                "incorrect_answer")
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
        if event in ["end", "pause", "resume", "board"] or s.get("paused") or s["state"] == "SESSION_SUMMARY":
            return TeachingPolicy().decide(s, text, event, result)
        return Decision("EXPLAIN", "根据用户消息自然回应。不要报告未测量的掌握程度。", "baseline", "fast")
