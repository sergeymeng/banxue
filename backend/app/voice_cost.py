"""Audio reservations share the existing GBP ledger and single-worker budget semantics."""
from datetime import datetime, timezone

from sqlalchemy import func, select

from .db import Usage
from .llm import ModelError


class AudioCharge:
    def __init__(self, factory, settings, lesson_id, role, model, units, cny_rate, unit):
        self.factory, self.settings = factory, settings
        self.rate = cny_rate * settings.voice_cny_to_gbp
        reserve = units * self.rate
        # Synchronous reserve+commit has no await; atomic with other reservations on this event loop.
        with factory() as db:
            total = db.scalar(select(func.coalesce(func.sum(Usage.charged_gbp), 0)).where(Usage.lesson_id == lesson_id))
            day = datetime.now(timezone.utc).date().isoformat()
            daily = db.scalar(select(func.coalesce(func.sum(Usage.charged_gbp), 0)).where(Usage.created_at >= day))
            if (reserve > settings.request_budget_gbp or total + reserve > settings.session_budget_gbp
                    or daily + reserve > settings.daily_budget_gbp):
                raise ModelError("语音预算不足，请在设置中调整预算。", "budget_exceeded")
            row = Usage(lesson_id=lesson_id, charged_gbp=reserve, data={
                "role": role, "model": model, "status": "reserved", "estimated_cost_gbp": reserve,
                "usage_source": "reservation", "unit": unit, "reserved_units": units,
                "price_cny_per_unit": cny_rate, "cny_to_gbp": settings.voice_cny_to_gbp,
                "actual_usage": None, "latency_ms": None,
            })
            db.add(row)
            db.commit()
            self.id = row.id

    def finish(self, *, units=None, actual=None, status="completed", raw_usage=None):
        with self.factory() as db:
            row = db.get(Usage, self.id)
            if not row:  # Teacher may have been deleted.
                return
            if units is not None and status == "completed":
                row.charged_gbp = units * self.rate
            row.data = {**row.data, "status": status, "actual_usage": actual if actual is not None else raw_usage,
                        "estimated_cost_gbp": row.charged_gbp,
                        "usage_source": "provider" if actual is not None and status == "completed"
                        else "local_measurement" if units is not None and status == "completed"
                        else "uncertain_reservation", "measured_units": units}
            db.commit()
