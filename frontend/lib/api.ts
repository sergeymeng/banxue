export const API = process.env.NEXT_PUBLIC_API_URL ?? (typeof window !== 'undefined' && window.desktop ? '' : 'http://127.0.0.1:8000');
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const res = await fetch(API + path, { ...init, headers });
  const value = await res.json();
  if (!res.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '请求未完成，请检查输入。');
  return value;
}
export type Teacher = { id: string; name: string; subject: string; language: string; style: string; preferences: string; default_role: string };
export type Message = { role: string; content: string };
export type Decision = { action: string; reason: string; auto: boolean; role: string };
export type Lesson = { id: string; teacher_id: string; state: string; mode: string; paused: boolean; messages: Message[]; board?: Record<string, unknown>; topic_index: number; current_exercise?: string; profile: Record<string, string>; plan?: string[]; summary?: unknown; last_decision?: Decision };
export type Turn = { lesson: Lesson; decision?: Decision; sources: Source[]; observation?: { visible_text: string; confidence: number; observation: string; step_complete: boolean }; skipped?: string };
export type Source = { document_id: string; page: string; heading: string; content: string };
export type Material = { id: string; name: string; pages: number; status: string; unreadable_pages: number[]; scope: string };
export type Knowledge = { topic: string; attempts: number; correct: number; observed_accuracy: number; confidence: number; next_review: string; evidence: string[] };
export type Usage = { estimated_cost_gbp: number; input_tokens: number; output_tokens: number; billing_note: string; requests: { id: string; role: string; model: string; latency_ms: number | null; estimated_cost_gbp: number; usage_source: string; status: string; cached_tokens: number | null }[] };
export type Config = { mode: string; roles: Record<string, { model: string; base_url: string; input_gbp: number | null; output_gbp: number | null }>; budgets: { request: number; session: number; day: number }; context_tokens: number; retention: boolean };
export const STATE_NAMES: Record<string, string> = { ONBOARDING: '初次交流', DIAGNOSTIC: '诊断测试', PLANNING: '制定计划', EXPLAINING: '知识讲解', GUIDED_PRACTICE: '引导练习', INDEPENDENT_PRACTICE: '独立练习', REVIEW: '回顾复习', SESSION_SUMMARY: '课堂总结' };
