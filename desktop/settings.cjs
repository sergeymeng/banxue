const ROLES = ['fast', 'reasoning', 'vision'];
const voiceDefaults = () => ({ enabled: false, region: 'beijing', api_key: '', workspace: '', llm_model: 'qwen-flash', asr_model: 'qwen-audio-3.0-asr-flash-streaming', tts_model: 'qwen3-tts-flash-realtime', voice: 'Cherry', input_cny: null, output_cny: null, asr_cny_second: null, tts_cny_10k: null, cny_to_gbp: null });
const defaults = () => ({ voice: voiceDefaults(), mode: 'demo', token_field: 'max_completion_tokens', budgets: { request: .15, session: 3, day: 5 }, roles: Object.fromEntries(ROLES.map(role => [role, { base_url: 'https://api.openai.com/v1', model: role === 'reasoning' ? 'gpt-4.1' : 'gpt-4.1-mini', api_key: '', input_gbp: null, output_gbp: null }])) });
function validateSettings(input, previous = defaults()) {
  if (!input || !['demo', 'live'].includes(input.mode)) throw new Error('请选择演示或真实模型。');
  const next = defaults(); next.mode = input.mode;
  if (!['max_tokens', 'max_completion_tokens'].includes(input.token_field)) throw new Error('输出参数无效。');
  next.token_field = input.token_field;
  for (const key of ['request', 'session', 'day']) {
    const value = input.budgets?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000) throw new Error('预算必须是 0 到 10000 之间的数值。');
    next.budgets[key] = value;
  }
  for (const role of ROLES) {
    const value = input.roles?.[role];
    if (!value || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 150) throw new Error('请填写模型名称。');
    const url = new URL(value.base_url);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('远程地址需要 HTTPS；本地模型可使用 localhost HTTP。密钥应填入密钥栏。');
    if (typeof value.api_key !== 'string' && value.api_key !== null) throw new Error('密钥格式无效。');
    if (value.api_key?.length > 4096) throw new Error('密钥过长。');
    const config = { base_url: url.href.replace(/\/$/, ''), model: value.model.trim(), api_key: value.api_key === null ? '' : value.api_key || previous.roles[role].api_key };
    for (const price of ['input_gbp', 'output_gbp']) {
      const n = value[price];
      if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1000000)) throw new Error('Token 单价无效。');
      if (input.mode === 'live' && n === null) throw new Error('真实模型需要填写三个角色的输入和输出单价；本地免费模型可填 0。');
      config[price] = n;
    }
    next.roles[role] = config;
  }
  const voice = input.voice || previous.voice || voiceDefaults();
  const oldVoice = previous.voice || voiceDefaults();
  if (typeof voice.enabled !== 'boolean' || !['beijing', 'singapore'].includes(voice.region)) throw new Error('语音地域无效。');
  next.voice.enabled = voice.enabled; next.voice.region = voice.region;
  for (const key of ['workspace', 'llm_model', 'asr_model', 'tts_model', 'voice']) {
    if (typeof voice[key] !== 'string' || voice[key].length > 150 || (key !== 'workspace' && !voice[key].trim())) throw new Error('语音模型配置无效。');
    next.voice[key] = voice[key].trim();
  }
  if (next.voice.workspace && !/^[a-zA-Z0-9-]{1,80}$/.test(next.voice.workspace)) throw new Error('业务空间 ID 无效。');
  if (voice.api_key !== null && (typeof voice.api_key !== 'string' || voice.api_key.length > 4096)) throw new Error('语音密钥无效。');
  next.voice.api_key = voice.api_key === null ? '' : voice.api_key || oldVoice.api_key;
  for (const key of ['input_cny', 'output_cny', 'asr_cny_second', 'tts_cny_10k', 'cny_to_gbp']) {
    const n = voice[key];
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1000000 || (key === 'cny_to_gbp' && (n <= 0 || n > 10)))) throw new Error('语音单价或换算系数无效。');
    next.voice[key] = n;
  }
  return next;
}
function publicSettings(config) {
  return { ...config, voice: { ...(config.voice || voiceDefaults()), api_key: '', has_key: !!config.voice?.api_key }, roles: Object.fromEntries(ROLES.map(role => { const { api_key, ...rest } = config.roles[role]; return [role, { ...rest, api_key: '', has_key: !!api_key }]; })) };
}
function toEnvironment(config) {
  const env = { MODEL_MODE: config.mode, COMPLETION_TOKEN_FIELD: config.token_field, REQUEST_BUDGET_GBP: String(config.budgets.request), SESSION_BUDGET_GBP: String(config.budgets.session), DAILY_BUDGET_GBP: String(config.budgets.day) };
  for (const role of ROLES) for (const [key, value] of Object.entries(config.roles[role])) if (value !== null) env[`${role}_${key}`.toUpperCase()] = String(value);
  for (const [key, value] of Object.entries(config.voice || voiceDefaults())) if (value !== null) env[`VOICE_${key.toUpperCase()}`] = String(value);
  return env;
}
module.exports = { defaults, validateSettings, publicSettings, toEnvironment };
