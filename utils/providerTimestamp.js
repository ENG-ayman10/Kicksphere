// Source freshness is distinct from the time KickSphere observed/emitted it.
// Accept only a real zoned ISO instant; never substitute the server clock.
function normalizeProviderTimestamp(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const date = value.slice(0, 10);
  const day = Date.parse(`${date}T00:00:00Z`);
  const instant = Date.parse(value);
  if (!Number.isFinite(day) || !Number.isFinite(instant) || new Date(day).toISOString().slice(0, 10) !== date) return null;
  return new Date(instant).toISOString();
}

module.exports = { normalizeProviderTimestamp };
