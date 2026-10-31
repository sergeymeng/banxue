from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    data_dir: Path = Path("data")
    frontend_dir: Path | None = None
    desktop_token: str = ""
    model_mode: Literal["demo", "live"] = "demo"
    fast_base_url: str = "https://api.openai.com/v1"
    reasoning_base_url: str = "https://api.openai.com/v1"
    vision_base_url: str = "https://api.openai.com/v1"
    fast_model: str = "gpt-4.1-mini"
    reasoning_model: str = "gpt-4.1"
    vision_adapter: Literal["chat_completions", "qwen_vl"] = "chat_completions"
    vision_model: str = "gpt-4.1-mini"
    fast_api_key: str = ""
    reasoning_api_key: str = ""
    vision_api_key: str = ""
    fast_input_gbp: float | None = Field(default=None, ge=0)
    fast_output_gbp: float | None = Field(default=None, ge=0)
    fast_cached_gbp: float | None = Field(default=None, ge=0)
    reasoning_input_gbp: float | None = Field(default=None, ge=0)
    reasoning_output_gbp: float | None = Field(default=None, ge=0)
    reasoning_cached_gbp: float | None = Field(default=None, ge=0)
    vision_input_gbp: float | None = Field(default=None, ge=0)
    vision_output_gbp: float | None = Field(default=None, ge=0)
    vision_cached_gbp: float | None = Field(default=None, ge=0)
    request_budget_gbp: float = Field(default=0.15, ge=0)
    session_budget_gbp: float = Field(default=3, ge=0)
    daily_budget_gbp: float = Field(default=5, ge=0)
    context_tokens: int = Field(default=4200, ge=1800, le=32000)
    max_output_tokens: int = Field(default=700, ge=64, le=8192)
    vision_max_output_tokens: int = Field(default=4096, ge=256, le=16384)
    vision_token_allowance: int = Field(default=6000, ge=1000)
    history_messages: int = Field(default=8, ge=0, le=30)
    request_timeout: float = Field(default=45, gt=0)
    completion_token_field: str = "max_completion_tokens"
    retain_transcripts: bool = True
    allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    voice_enabled: bool = False
    voice_region: Literal["beijing", "singapore"] = "beijing"
    voice_api_key: str = ""
    voice_workspace: str = ""
    voice_llm_model: str = "qwen-flash"
    voice_asr_model: str = "qwen-audio-3.0-asr-flash-streaming"
    voice_tts_model: str = "qwen3-tts-flash-realtime"
    voice_voice: str = "Cherry"
    # CNY prices, converted explicitly to the application's GBP ledger.
    voice_input_cny: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    voice_output_cny: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    voice_asr_cny_second: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    voice_tts_cny_10k: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    voice_cny_to_gbp: float | None = Field(default=None, gt=0, le=10, allow_inf_nan=False)
    voice_session_seconds: int = Field(default=1800, ge=60, le=3600)
    voice_utterance_seconds: int = Field(default=60, ge=5, le=120)

    def role(self, role: str):
        return {
            key: getattr(self, f"{role}_{key}")
            for key in ("base_url", "model", "api_key", "input_gbp", "output_gbp", "cached_gbp")
        }
