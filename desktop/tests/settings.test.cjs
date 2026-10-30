const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, validateSettings, publicSettings, toEnvironment } = require('../settings.cjs');
test('public settings never return saved provider keys', () => {
  const value = defaults(); value.roles.fast.api_key = 'test-secret';
  const publicValue = publicSettings(value);
  assert.equal(publicValue.roles.fast.has_key, true);
  assert.equal(publicValue.roles.fast.api_key, '');
  assert.ok(!JSON.stringify(publicValue).includes('test-secret'));
});
test('blank input retains a key; null explicitly removes it', () => {
  const previous = defaults(); previous.roles.fast.api_key = 'test-secret';
  assert.equal(validateSettings(defaults(), previous).roles.fast.api_key, 'test-secret');
  const next = defaults(); next.roles.fast.api_key = null;
  assert.equal(validateSettings(next, previous).roles.fast.api_key, '');
});
test('reject remote plaintext endpoint and credentials in URL', () => {
  for (const url of ['http://example.com/v1','https://secret@example.com/v1','https://example.com/v1?key=secret','file:///etc/passwd']) {
    const value = defaults(); value.roles.fast.base_url = url;
    assert.throws(() => validateSettings(value));
  }
});
test('live mode requires known prices, local zero is allowed', () => {
  const value = defaults(); value.mode = 'live';
  assert.throws(() => validateSettings(value));
  for (const role of Object.values(value.roles)) { role.base_url = 'http://localhost:11434/v1'; role.input_gbp = 0; role.output_gbp = 0; }
  assert.equal(validateSettings(value).mode, 'live');
});
test('invalid budgets fail and extra configuration cannot become environment variables', () => {
  const value = defaults(); value.budgets.day = NaN;
  assert.throws(() => validateSettings(value));
  const next = defaults(); next.PATH = 'untrusted'; next.roles.fast.evil = 'bad';
  const env = toEnvironment(validateSettings(next));
  assert.equal(env.PATH, undefined); assert.equal(env.FAST_EVIL, undefined);
});
test('voice uses one secret, strips it from renderer and preserves/removes securely', () => {
  const previous = defaults(); previous.voice.api_key = 'voice-secret';
  const next = validateSettings(defaults(), previous);
  assert.equal(next.voice.api_key, 'voice-secret');
  assert.equal(publicSettings(next).voice.has_key, true);
  assert.ok(!JSON.stringify(publicSettings(next)).includes('voice-secret'));
  assert.equal(toEnvironment(next).VOICE_API_KEY, 'voice-secret');
  const cleared = defaults(); cleared.voice.api_key = null;
  assert.equal(validateSettings(cleared, previous).voice.api_key, '');
  const legacy = defaults(); delete legacy.voice;
  assert.equal(validateSettings(legacy).voice.enabled, false);
});
test('voice settings reject injected fields, malformed workspace and NaN rates', () => {
  const value = defaults(); value.voice.api_key = ''; value.voice.evil = 'bad';
  assert.equal(toEnvironment(validateSettings(value)).VOICE_EVIL, undefined);
  value.voice.workspace = 'key@example.com'; assert.throws(() => validateSettings(value));
  value.voice.workspace = ''; value.voice.cny_to_gbp = NaN; assert.throws(() => validateSettings(value));
});
const { microphoneAllowed } = require('../permissions.cjs');
test('microphone permission is limited to trusted main window, audio only', () => {
  const wc = { getURL: () => 'http://127.0.0.1:9000/' };
  const input = { wc, expected: wc, origin: 'http://127.0.0.1:9000', permission: 'media', details: { requestingUrl: 'http://127.0.0.1:9000/', isMainFrame: true, mediaTypes: ['audio'] } };
  assert.equal(microphoneAllowed(input), true);
  assert.equal(microphoneAllowed({ ...input, wc: {} }), false);
  for (const details of [{ ...input.details, mediaTypes: ['audio', 'video'] }, { ...input.details, isMainFrame: false }, { ...input.details, requestingUrl: 'https://evil.example/' }, { ...input.details, mediaTypes: [] }]) assert.equal(microphoneAllowed({ ...input, details }), false);
  assert.equal(microphoneAllowed({ ...input, permission: 'notifications' }), false);
});
