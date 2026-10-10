const { isQuarantinedProviderFixture } = require('./providerFixtureQuarantine');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_INTERVAL_MS = 26 * 60 * 60 * 1000;

// Calendar requests are explicit UTC instants, never server-local dates.
function parseUtcInstant(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const milliseconds = Number((parts[7] || '').padEnd(3, '0'));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  // Date.parse accepts rolled-over dates and 24:00; neither is an exact input instant.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second ||
      date.getUTCMilliseconds() !== milliseconds) return null;
  return timestamp;
}

function parseMatchInterval(from, to) {
  const fromMs = parseUtcInstant(from);
  const toMs = parseUtcInstant(to);
  if (fromMs === null || toMs === null) {
    return { error: 'from and to must both be UTC ISO timestamps ending in Z' };
  }
  if (toMs <= fromMs || toMs - fromMs > MAX_INTERVAL_MS) {
    return { error: 'Match interval must be positive and must not exceed 26 hours' };
  }
  const utcDates = [];
  // Subtract a millisecond so an exclusive midnight end does not fetch the next day.
  const lastDay = Math.floor((toMs - 1) / DAY_MS) * DAY_MS;
  for (let day = Math.floor(fromMs / DAY_MS) * DAY_MS; day <= lastDay; day += DAY_MS) {
    utcDates.push(new Date(day).toISOString().slice(0, 10));
  }
  return {
    fromMs, toMs, utcDates,
    range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), toExclusive: true },
  };
}

function fixtureTimestamp(value) {
  if (typeof value !== 'string') return null;
  // Provider times may include an explicit UTC offset. A date alone is not a kickoff time.
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return null;
  const day = Date.parse(`${parts[1]}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== parts[1]) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function selectMatchesInInterval(matches, fromMs, toMs) {
  const seen = new Set();
  const selected = [];
  let invalidRecords = 0;
  let outsideInterval = 0;
  for (const match of matches) {
    const id = match?.id;
    const timestamp = fixtureTimestamp(match?.utcDate);
    if ((typeof id !== 'string' && typeof id !== 'number') ||
        !String(id).trim() || (typeof id === 'number' && !Number.isFinite(id)) || timestamp === null) {
      invalidRecords++;
      continue;
    }
    if (timestamp < fromMs || timestamp >= toMs) {
      outsideInterval++;
      continue;
    }
    if (isQuarantinedProviderFixture(match, timestamp)) {
      invalidRecords++;
      continue;
    }
    const key = String(id);
    if (!seen.has(key)) {
      seen.add(key);
      selected.push({ match, timestamp });
    }
  }
  selected.sort((a, b) => a.timestamp - b.timestamp);
  return { data: selected.map(item => item.match), invalidRecords, outsideInterval };
}

module.exports = { parseMatchInterval, selectMatchesInInterval };
