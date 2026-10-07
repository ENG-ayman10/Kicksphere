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

module.exports = { sportscoreMatchLocator, sameSportscoreFixture };
