"""Offline expression of a policy decision; never changes state or judges mastery."""

from .teaching_observations import confirmed_observation


def demo_reply(state, decision, text):
    if state.get("mode") == "baseline":
        return "当前为离线演示，只支持内置求导课程。配置真实模型后才能运行 LLM 基线。"
    if decision.reason == "student_detour":
        topic = state.get("topic_index", 0)
        if topic == 0 and any(w in text.lower() for w in ("内层", "链式", "chain", "为什么乘")):
            return "内层也随 x 变化，所以外层的变化率还要乘内层的变化率。你这题的内层函数是什么？"
        if topic == 1 and any(w in text for w in ("展开", "乘积", "两项")):
            return "两个因子都可能随 x 变化，所以乘积法则包含两项。也可以先展开，再逐项求导。"
        if topic == 2 and any(w in text for w in ("常数", "指数", "幂")):
            return "幂函数求导时，系数乘原指数，指数减一；常数项的导数是 0。你想检查哪一项？"
        return "离线演示暂时不能回答这个追问。原题进度已保留，可以说“回到原题”。"
    if decision.reason == "voice_question":
        return "我听到的是「" + text[:80] + "」。请确认关键符号，或把表达式打出来，我再检查这一步。"
    if decision.reason == "completed_step":
        visible = str((confirmed_observation(state) or {}).get("visible_text", ""))[:100]
        return "你核对的这一步是「" + visible + "」。这里用了哪条求导规则？"
    if decision.reason in {"step_passed", "step_retry", "incorrect_answer", "correction_received"}:
        return "你刚才写的是「" + text[:80] + "」。" + decision.instruction
    return decision.instruction
