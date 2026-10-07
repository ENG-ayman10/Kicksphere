// The human slug is the widget lookup key; the second URL segment identifies
// the particular fixture. Keep the established concatenated application ID.
function sportscoreMatchLocator(value) {
  if (typeof value !== 'string') return null;
  const match = /^\/football\/match\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+)\/?$/.exec(value.trim());
  if (!match) return null;
  const [, slug, token] = match;
  return { id: slug + token, slug, token, url: `/football/match/${slug}/${token}/` };
}

function sameSportscoreFixture(left, right) {
  return Boolean(left && right && left.slug === right.slug && left.token === right.token);
}

// Cold resolution supports the observed 15-character lowercase alphanumeric
// opaque tokens in canonical football fixture URLs.
// Saved application IDs concatenate it directly after the human widget slug.
// This split is only a lookup candidate, never proof of fixture identity:
// callers must compare the returned full provider URL, token and application ID.
function sportscoreMatchLookupCandidate(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*-vs-[a-z0-9]+(?:-[a-z0-9]+)*)([a-z0-9]{15})$/.exec(value);
  if (!match) return null;
  const [, slug, token] = match;
  return sportscoreMatchLocator(`/football/match/${slug}/${token}/`);
}

module.exports = { sportscoreMatchLocator, sameSportscoreFixture, sportscoreMatchLookupCandidate };
