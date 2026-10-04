// Read-only release checks. Requests public GET endpoints only; no account,
// favorites, push notification or database write is created by this command.
const fs = require('node:fs/promises');

function optionsFromArgs(args) {
  const options = { allowLocal: false, date: new Date().toISOString().slice(0, 10), teamId: 'bsd_t_57' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--allow-local') options.allowLocal = true;
    else if (['--date', '--team', '--report'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[{ '--date': 'date', '--team': 'teamId', '--report': 'reportPath' }[arg]] = value;
    } else if (!arg.startsWith('--') && !options.origin) options.origin = arg;
    else throw new Error('Unexpected argument');
  }
  let url;
  try { url = new URL(options.origin); } catch { throw new Error('Provide a backend HTTPS origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(options.allowLocal && loopback && url.protocol === 'http:'))) {
    throw new Error('Use an HTTPS origin; loopback HTTP needs --allow-local');
  }
  const day = new Date(`${options.date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date) || !Number.isFinite(day.getTime()) ||
      day.toISOString().slice(0, 10) !== options.date) throw new Error('Use a real calendar date YYYY-MM-DD');
  if (!/^bsd_t_[1-9]\d{0,14}$/.test(options.teamId)) throw new Error('Use a scoped BSD team ID');
  return { ...options, origin: url.origin, from: day.toISOString(),
    to: new Date(day.getTime() + 86400000).toISOString() };
}

function assert(condition, message) { if (!condition) throw new Error(message); }
async function readBoundedResponse(response, limit) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > limit) {
    await response.body?.cancel();
    throw new Error('Response exceeded the verification size limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      assert(length <= limit, 'Response exceeded the verification size limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// Check complete container boundaries, not just a magic prefix. Rendering still
// needs browser/device verification; this is not a general-purpose image decoder.
function imageContainerType(value) {
  const bytes = Buffer.from(value);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8, header = false, data = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8).toString();
      if (offset + 12 + length > bytes.length) return null;
      if (!header) {
        if (type !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(offset + 8) ||
            !bytes.readUInt32BE(offset + 12)) return null;
        header = true;
      }
      if (type === 'IDAT' && length > 0) data = true;
      if (type === 'IEND') return length === 0 && data && offset + 12 === bytes.length ? 'image/png' : null;
      offset += 12 + length;
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 &&
      bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
    let offset = 2, frame = false;
    while (offset < bytes.length - 2) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length - 2) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8 || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5)) return null;
        frame = true;
      }
      if (marker === 218) return frame && offset + length < bytes.length - 2 ? 'image/jpeg' : null;
      offset += length;
    }
    return null;
  }
  if (bytes.length >= 20 && bytes.subarray(0, 4).toString() === 'RIFF' &&
      bytes.subarray(8, 12).toString() === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8) {
    let offset = 12, image = false;
    while (offset + 8 <= bytes.length) {
      const type = bytes.subarray(offset, offset + 4).toString();
      const length = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + length + (length % 2) > bytes.length) return null;
      if (['VP8 ', 'VP8L', 'ANMF'].includes(type) && length >= 5) image = true;
      offset += 8 + length + (length % 2);
    }
    return image && offset === bytes.length ? 'image/webp' : null;
  }
  return null;
}
function coverageSummary(value) {
  const coverage = value && typeof value === 'object' ? value : {};
  return { available: coverage.available === true, complete: coverage.complete === true,
    partial: coverage.partial === true, possiblyTruncated: coverage.possiblyTruncated === true };
}
function assertCalendar(body, options) {
  assert(body.success === true && Array.isArray(body.data), 'Calendar payload is unavailable');
  assert(body.range?.from === options.from && body.range?.to === options.to && body.range?.toExclusive === true,
    'Calendar did not echo the requested exclusive UTC interval');
  assert(body.source !== 'unavailable' && ['bsd', 'sportscore', 'kickoffapi'].some(source =>
    String(body.source).split('+').includes(source)) && body.coverage?.available === true,
    'Calendar provider is unavailable');
  assert(body.coverage && typeof body.coverage.complete === 'boolean' &&
    typeof body.coverage.partial === 'boolean', 'Calendar omits its coverage contract');
  const matches = [];
  for (const group of body.data) {
    assert(Array.isArray(group.matches), 'Calendar group omits matches');
    matches.push(...group.matches);
  }
  const seen = new Set();
  for (const match of matches) {
    assert(typeof match.id === 'string' && match.id && !seen.has(match.id), 'Calendar contains missing or duplicate identities');
    seen.add(match.id);
    const kickoffParts = typeof match.utcDate === 'string' &&
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(match.utcDate);
    assert(kickoffParts,
      'Calendar kickoff omits an explicit timezone');
    const day = new Date(`${kickoffParts[1]}T00:00:00Z`);
    assert(Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === kickoffParts[1] &&
      Number(kickoffParts[2]) <= 23 && Number(kickoffParts[3]) <= 59 && Number(kickoffParts[4]) <= 59,
      'Calendar kickoff is not a real date and time');
    const timestamp = Date.parse(match.utcDate);
    assert(Number.isFinite(timestamp) && timestamp >= Date.parse(options.from) && timestamp < Date.parse(options.to),
      'Calendar contains an out-of-range kickoff');
    assert(match.homeTeam?.name && match.awayTeam?.name && match.competition?.code, 'Fixture omits teams or competition');
    if (match.id.startsWith('bsd_')) {
      assert(/^bsd_[1-9]\d*$/.test(match.id) && /^bsd_t_[1-9]\d*$/.test(match.homeTeam.id) &&
        /^bsd_t_[1-9]\d*$/.test(match.awayTeam.id), 'BSD fixture mixes provider identities');
    }
  }
  assert(body.total === matches.length, 'Calendar total disagrees with returned fixtures');
  return matches;
}

async function runSportsSmoke(options, fetchImpl = fetch) {
  const report = { checkedAt: new Date().toISOString(), origin: options.origin,
    readOnly: true, range: { from: options.from, to: options.to }, checks: [], warnings: [],
    scope: 'API integration and returned UTC-day coverage; not worldwide data accuracy or push delivery' };
  async function request(name, path, validate, { binary = false, expectedStatus = 200 } = {}) {
    const started = Date.now();
    const check = { name, endpoint: path, passed: false };
    report.checks.push(check);
    try {
      const response = await fetchImpl(new URL(path, options.origin), { method: 'GET',
        redirect: 'error', signal: AbortSignal.timeout(20000) });
      check.status = response.status;
      assert(response.status === expectedStatus, `Expected HTTP ${expectedStatus}`);
      const bytes = await readBoundedResponse(response, binary ? 1048576 : 4194304);
      const body = binary ? bytes : JSON.parse(new TextDecoder().decode(bytes));
      const details = validate(body, response) || {};
      Object.assign(check, details, { passed: true });
      return body;
    } catch (error) {
      // Never print response bodies, credentials or a transport configuration.
      check.error = error instanceof SyntaxError ? 'Response was not JSON' :
        ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name) ? 'Request unavailable or timed out' : error.message;
      return null;
    } finally { check.ms = Date.now() - started; }
  }
  await request('health', '/api/health', body => {
    assert(body.success === true, 'Health reports failure');
    return { environment: ['development', 'test', 'production'].includes(body.environment) ? body.environment : 'unknown' };
  });
  await request('readiness', '/api/ready', body => {
    assert(body.success === true && body.status === 'ready', 'Service is not ready');
  });
  await request('BSD catalog', '/api/stats/deep/competitions', body => {
    assert(body.success === true && Array.isArray(body.data) && body.data.length > 0, 'Competition catalog is empty');
    assert(String(body.source).split('+').includes('bsd') && body.data.some(row => row.provider === 'bsd' || row.source === 'bsd'),
      'BSD catalog is not active');
    const codes = body.data.map(row => row.code);
    assert(codes.every(code => typeof code === 'string' && code) && new Set(codes).size === codes.length,
      'Competition catalog contains conflicting codes');
    return { count: body.data.length, coverage: coverageSummary(body.coverage) };
  });
  const query = new URLSearchParams({ from: options.from, to: options.to });
  const calendar = await request('UTC calendar', `/api/matches?${query}`, body => {
    const matches = assertCalendar(body, options);
    const coverage = coverageSummary(body.coverage);
    if (!coverage.complete || coverage.partial || coverage.possiblyTruncated) report.warnings.push('Returned day coverage is partial or uncertified');
    return { count: matches.length, coverage };
  });
  const team = await request('BSD team', `/api/stats/deep/team/${options.teamId}`, body => {
    assert(body.success === true && body.source === 'bsd' && body.data?.info?.id === options.teamId,
      'Club response changed provider or identity');
    assert(body.data.info.name, 'Club name is unavailable');
  });
  const squad = await request('BSD squad', `/api/teams/${options.teamId}/squad`, body => {
    assert(body.success === true && body.source === 'bsd' && Array.isArray(body.data) && body.data.length > 0,
      'Reference club squad is unavailable');
    const ids = body.data.map(player => player.id);
    assert(ids.every(id => /^bsd_p_[1-9]\d*$/.test(id)) && new Set(ids).size === ids.length,
      'Squad contains conflicting player identities');
    return { count: ids.length, coverage: coverageSummary(body.coverage) };
  });
  const playerId = squad?.data?.[0]?.id;
  if (playerId) await request('BSD player round trip', `/api/stats/deep/player/${playerId}`, body => {
    assert(body.success === true && body.source === 'bsd' && body.data?.info?.id === playerId,
      'Player response changed provider or identity');
    const currentTeam = body.data.info.currentTeam?.id;
    assert(!currentTeam || currentTeam === options.teamId, 'Squad and current player club disagree');
  });
  else report.checks.push({ name: 'BSD player round trip', passed: false, error: 'No verified squad player available' });
  await request('BSD public image', `/api/images/bsd/team/${options.teamId.slice(6)}`, (bytes, response) => {
    const expectedType = imageContainerType(bytes);
    assert(expectedType && response.headers.get('content-type')?.split(';')[0] === expectedType,
      'Image content is not a complete supported image container');
    return { bytes: bytes.length };
  }, { binary: true });
  await request('Invalid BSD identity rejected', '/api/stats/deep/player/bsd_p_0', body => {
    assert(body.success === false, 'Malformed identity unexpectedly succeeded');
  }, { expectedStatus: 404 });
  report.success = report.checks.every(check => check.passed);
  report.calendarCoverage = calendar ? coverageSummary(calendar.coverage) : null;
  report.teamVerified = Boolean(team);
  return report;
}

async function main() {
  const options = optionsFromArgs(process.argv.slice(2));
  const report = await runSportsSmoke(options);
  if (options.reportPath) await fs.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.success) process.exitCode = 1;
}
if (require.main === module) main().catch(() => {
  console.error('Sports smoke failed. Usage: node scripts/smoke-sports.js https://backend.example.com [--allow-local] [--date YYYY-MM-DD] [--team bsd_t_ID] [--report path]');
  process.exitCode = 1;
});
module.exports = { optionsFromArgs, assertCalendar, runSportsSmoke, readBoundedResponse, imageContainerType };
