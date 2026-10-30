"""Small audited problem bank; no claims of full A-level syllabus coverage."""

import ast
import re
from fractions import Fraction

BANK = [
    dict(
        topic="chain_rule",
        title="链式法则",
        question="求 y=(3x+1)^2 的导数。写出 dy/dx = …",
        answer="18*x+6",
        hint="把外层平方与内层 3x+1 分开；内层的导数是什么？",
        explanation="若 y=u²、u=3x+1，则 dy/dx=2u·3=6(3x+1)。内函数的导数不能漏掉。",
        practice="求 y=(2x+3)^3 的导数。",
        practice_answer="6*(2*x+3)^2",
        independent="求 y=(x^2+1)^3 的导数。",
        independent_answer="6*x*(x^2+1)^2",
    ),
    dict(
        topic="product_rule",
        title="乘积法则",
        question="求 y=x²(x+1) 的导数。",
        answer="3*x^2+2*x",
        hint="你可以先展开；如果用乘积法则，两项分别是什么？",
        explanation="(uv)′=u′v+uv′。所以 [x²(x+1)]′=2x(x+1)+x²=3x²+2x。",
        practice="求 y=x²(2x+1) 的导数。",
        practice_answer="6*x^2+2*x",
        independent="求 y=(x²+1)(x+2) 的导数。",
        independent_answer="3*x^2+4*x+1",
    ),
    dict(
        topic="power_rule",
        title="幂函数求导",
        question="求 y=4x³−2x²+7 的导数。",
        answer="12*x^2-4*x",
        hint="对每一项分别求导，常数项的导数是多少？",
        explanation="(axⁿ)′=anxⁿ⁻¹；常数导数为 0。所以 (4x³−2x²+7)′=12x²−4x。",
        practice="求 y=3x⁴−5x²+2 的导数。",
        practice_answer="12*x^3-10*x",
        independent="求 y=2x⁵−3x³+x 的导数。",
        independent_answer="10*x^4-9*x^2+1",
    ),
]


def bounded(value):
    if value.numerator.bit_length() > 4096 or value.denominator.bit_length() > 4096:
        raise ValueError("coefficient limit")
    return value


def add(a, b):
    out = dict(a)
    for degree, value in b.items():
        out[degree] = bounded(out.get(degree, Fraction(0)) + value)
    return {k: v for k, v in out.items() if v}


def mul(a, b):
    out = {}
    for i, x in a.items():
        for j, y in b.items():
            if i + j > 32:
                raise ValueError("degree limit")
            out[i + j] = bounded(out.get(i + j, Fraction(0)) + x * y)
    return {k: v for k, v in out.items() if v}


def polynomial(source: str):
    source = source.strip().lower().replace("²", "^2").replace("³", "^3").replace("⁴", "^4").replace("⁵", "^5")
    source = source.replace("−", "-").replace("×", "*").replace("^", "**")
    if "=" in source:
        source = source.split("=")[-1].strip()
    if len(source) > 250 or not re.fullmatch(r"[0-9x+*/().\s-]+", source):
        raise ValueError("unsupported expression")
    source = re.sub(r"(\d|\))(?=x|\()", r"\1*", source)
    source = re.sub(r"x(?=\()", "x*", source)
    tree = ast.parse(source.strip(), mode="eval")
    if len(list(ast.walk(tree))) > 100:
        raise ValueError("expression too large")

    def walk(n):
        if isinstance(n, ast.Constant) and type(n.value) in (int, float) and abs(n.value) <= 1e8:
            return {0: Fraction(str(n.value))}
        if isinstance(n, ast.Name) and n.id == "x":
            return {1: Fraction(1)}
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.USub, ast.UAdd)):
            return {k: (-v if isinstance(n.op, ast.USub) else v) for k, v in walk(n.operand).items()}
        if isinstance(n, ast.BinOp):
            a, b = walk(n.left), walk(n.right)
            if isinstance(n.op, ast.Add):
                return add(a, b)
            if isinstance(n.op, ast.Sub):
                return add(a, {k: -v for k, v in b.items()})
            if isinstance(n.op, ast.Mult):
                return mul(a, b)
            if isinstance(n.op, ast.Div) and set(b) <= {0} and b.get(0):
                return {k: v / b[0] for k, v in a.items()}
            if isinstance(n.op, ast.Pow) and set(b) <= {0}:
                power = b.get(0, Fraction(0))
                if power.denominator == 1 and 0 <= power <= 8:
                    result = {0: Fraction(1)}
                    for _ in range(int(power)):
                        result = mul(result, a)
                    return result
        raise ValueError("unsupported expression")

    return {k: v for k, v in walk(tree.body).items() if v}


def grade(source, answer):
    try:
        return polynomial(source) == polynomial(answer)
    except (ValueError, SyntaxError, ZeroDivisionError, OverflowError, RecursionError):
        return None
