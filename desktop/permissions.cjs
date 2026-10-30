function microphoneAllowed({ wc, expected, origin, permission, details = {} }) {
  if (!expected || wc !== expected || permission !== 'media') return false;
  if (details.isMainFrame === false) return false;
  const url = details.requestingUrl || details.securityOrigin;
  try { if (new URL(url).origin !== origin || new URL(wc.getURL()).origin !== origin) return false; }
  catch { return false; }
  const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
  return types.length > 0 && types.every(type => type === 'audio');
}
module.exports = { microphoneAllowed };
