// Optional explicit audience restriction for local real-match validation.
// Account identifiers stay in server memory and are never included in health
// output or logs. Normal deployments without the override retain subscriptions.
function createLiveRecipientPolicy(env = process.env) {
  if (env.LOCAL_LIVE_PUSH_USER_IDS === undefined) return () => true;
  const allowed = new Set(String(env.LOCAL_LIVE_PUSH_USER_IDS).split(',')
    .map(value => value.trim()).filter(value => value && value.length <= 160));
  return userId => typeof userId === 'string' && allowed.has(userId);
}

module.exports = { createLiveRecipientPolicy };
