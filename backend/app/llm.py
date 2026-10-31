import asyncio
import json
import time
from datetime import datetime, timezone

import httpx
from sqlalchemy import func, select

from .context import tokens
from .db import Usage


class ModelError(Exception):
    def __init__(self, message, code="model_error"):
        self.message, self.code = message, code
        super().__init__(message)


class Gateway:
    def __init__(self, settings, transport=None):
        self.settings = settings
        self.transport = transport

    async def complete(self, db, lesson_id, role, messages, *, image=None, on_delta=None, image_detail="low", vision_protocol="chat_completions"):
        cfg, settings = self.settings.role(role), self.settings
        if vision_protocol not in {"chat_completions", "qwen_vl"} or (
            vision_protocol == "qwen_vl" and (role != "vision" or not image or on_delta)
        ):
            raise ModelError("视觉协议配置无效。", "configuration")
        qwen_vl = vision_protocol == "qwen_vl"
        if settings.model_mode == "demo":
            raise ModelError("演示模式不会调用模型。")
        if cfg["input_gbp"] is None or cfg["output_gbp"] is None:
            raise ModelError(
                "请先在后端 .env 填写该角色每百万 Token 的 GBP 价格；未知价格不能按零计费。", "configuration"
            )
        if settings.completion_token_field not in ["max_tokens", "max_completion_tokens"]:
            raise ModelError("COMPLETION_TOKEN_FIELD 配置无效。", "configuration")
        if not cfg["base_url"].startswith(
            ("https://", "http://localhost:", "http://127.0.0.1:", "http://host.docker.internal:")
        ):
            raise ModelError("远程模型端点必须使用 HTTPS。", "configuration")
        prompt_estimate = sum(tokens(m["content"]) + 12 for m in messages)
        if image:
            prompt_estimate += settings.vision_token_allowance
        output_limit = settings.vision_max_output_tokens if role == "vision" else settings.max_output_tokens
        reserve = (prompt_estimate * cfg["input_gbp"] + output_limit * cfg["output_gbp"]) / 1e6
        session_spend = db.scalar(
            select(func.coalesce(func.sum(Usage.charged_gbp), 0)).where(Usage.lesson_id == lesson_id)
        )
        today = datetime.now(timezone.utc).date().isoformat()
        daily_spend = db.scalar(select(func.coalesce(func.sum(Usage.charged_gbp), 0)).where(Usage.created_at >= today))
        if (
            reserve > settings.request_budget_gbp
            or session_spend + reserve > settings.session_budget_gbp
            or daily_spend + reserve > settings.daily_budget_gbp
        ):
            raise ModelError("预算不足，模型请求已暂停。请调整预算或选择价格更低的模型后重试。", "budget_exceeded")
        usage = Usage(
            lesson_id=lesson_id,
            charged_gbp=reserve,
            data={
                "role": role,
                "model": cfg["model"],
                "status": "reserved",
                "estimated_cost_gbp": reserve,
                "usage_source": "reservation",
                "input_tokens": prompt_estimate,
                "output_tokens": None,
                "cached_tokens": None,
                "latency_ms": None,
                "actual_usage": None,
            },
        )
        db.add(usage)
        db.commit()  # Survives network failure / process restart.
        payload_messages = list(messages)
        if image:
            payload_messages.append(
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "只观察这张白板当前可见内容。"},
                        {"type": "image_url", "image_url": ({"url": image} if qwen_vl else {"url": image, "detail": image_detail})},
                    ],
                }
            )
        payload = {
            "model": cfg["model"],
            "messages": payload_messages,
            ("max_tokens" if qwen_vl else settings.completion_token_field): output_limit,
        }
        if qwen_vl:
            # Explicit adapter choice only; multimodal JSON Schema is not a server-side guarantee.
            payload.update(response_format={"type": "json_object"}, enable_thinking=False)
        headers = {"Authorization": "Bearer " + cfg["api_key"]} if cfg["api_key"] else {}
        if on_delta:
            payload.update(stream=True, stream_options={"include_usage": True})
        if getattr(settings, "qwen_voice", False):
            payload["enable_thinking"] = False
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=settings.request_timeout, transport=self.transport) as client:
                if on_delta:
                    answer, actual, finished = "", None, False
                    async with client.stream("POST", cfg["base_url"].rstrip("/") + "/chat/completions",
                                             json=payload, headers=headers) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            data = line[5:].strip()
                            if data == "[DONE]":
                                finished = True
                                break
                            chunk = json.loads(data)
                            if chunk.get("usage"):
                                actual = chunk["usage"]
                            choices = chunk.get("choices") or []
                            delta = choices[0].get("delta", {}).get("content") if choices else None
                            if delta:
                                if not isinstance(delta, str) or len(answer) + len(delta) > 24000:
                                    raise ValueError("invalid stream")
                                answer += delta
                                await on_delta(delta)
                    if not finished:
                        raise ValueError("truncated stream")
                else:
                    response = await client.post(
                        cfg["base_url"].rstrip("/") + "/chat/completions", json=payload, headers=headers
                    )
                    response.raise_for_status()
                    body = response.json()
                    if role == "vision" and body["choices"][0].get("finish_reason") not in (None, "stop"):
                        raise ValueError("incomplete vision output")
                    answer = body["choices"][0]["message"]["content"]
                    actual = body.get("usage")
            if not isinstance(answer, str) or not answer.strip():
                raise ValueError("empty content")
            if (
                actual
                and isinstance(actual.get("prompt_tokens"), int)
                and isinstance(actual.get("completion_tokens"), int)
            ):
                inp, out = max(0, actual["prompt_tokens"]), max(0, actual["completion_tokens"])
                cached = min(inp, max(0, (actual.get("prompt_tokens_details") or {}).get("cached_tokens") or 0))
                cache_rate = cfg["cached_gbp"] if cfg["cached_gbp"] is not None else cfg["input_gbp"]
                cost = ((inp - cached) * cfg["input_gbp"] + cached * cache_rate + out * cfg["output_gbp"]) / 1e6
                source = "provider"
            else:
                inp, out, cached, cost, source = (
                    prompt_estimate,
                    tokens(answer),
                    None,
                    reserve,
                    "conservative_reservation",
                )
            usage.charged_gbp = cost
            usage.data = {
                **usage.data,
                "status": "completed",
                "input_tokens": inp,
                "output_tokens": out,
                "cached_tokens": cached,
                "usage_source": source,
                "actual_usage": actual,
                "estimated_cost_gbp": cost,
                "latency_ms": round((time.monotonic() - started) * 1000),
            }
            db.commit()
            return answer
        except asyncio.CancelledError:
            usage.data = {
                **usage.data,
                "status": "interrupted",
                "latency_ms": round((time.monotonic() - started) * 1000),
            }
            db.commit()
            raise ModelError("已中断当前模型请求。供应商可能已计费，估算额度仍保留。", "interrupted") from None
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError):
            # Never persist response bodies, headers, request prompts, or exception strings (may contain secrets).
            usage.data = {**usage.data, "status": "uncertain", "latency_ms": round((time.monotonic() - started) * 1000)}
            db.commit()
            raise ModelError(
                "模型请求失败或超时，未自动重试；费用可能已发生，已保留估算额度。请检查端点、密钥和模型。"
            ) from None
