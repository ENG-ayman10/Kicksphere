'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const root = path.resolve(__dirname, '..');
const localOrigin = 'http://127.0.0.1:3000';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseDevices(output) {
  return String(output).split(/\r?\n/).map(line => {
    const found = /^([\w.:-]+)\s+(device|offline|unauthorized)(?:\s|$)/.exec(line.trim());
    return found ? { serial: found[1], state: found[2] } : null;
  }).filter(Boolean);
}

function selectDevice(devices, serial) {
  if (serial) {
    const selected = devices.find(device => device.serial === serial);
    return selected || { serial, state: 'disconnected' };
  }
  const authorized = devices.filter(device => device.state === 'device');
  if (authorized.length > 1) return { state: 'multiple' };
  if (authorized.length === 1) return authorized[0];
  return devices[0] || { state: 'disconnected' };
}

function hasLocalReverse(output) {
  return String(output).split(/\r?\n/).some(line => {
    const columns = line.trim().split(/\s+/);
    return columns.length >= 3 && columns[columns.length - 2] === 'tcp:3000' &&
      columns[columns.length - 1] === 'tcp:3000';
  });
}

// A free socket and a running API are different states. Never replace an
// unrelated process just because its health route did not answer.
function isPortFree(port = 3000, host = '::') {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

async function probeBackend(origin = localOrigin) {
  try {
    const healthResponse = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
    const health = await healthResponse.json();
    if (!healthResponse.ok || health.success !== true ||
        typeof health.message !== 'string' || !health.message.startsWith('KickSphere Backend OK')) {
      return 'foreign';
    }
    const readyResponse = await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(2000) });
    const ready = await readyResponse.json();
    return readyResponse.ok && ready.success === true && ready.status === 'ready' ? 'ready' : 'not-ready';
  } catch (_) {
    return 'unreachable';
  }
}

function findAdb(env = process.env) {
  const candidates = [
    env.KICKSPHERE_ADB,
    env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
    env.ANDROID_SDK_ROOT && path.join(env.ANDROID_SDK_ROOT, 'platform-tools', 'adb.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  ];
  const installed = candidates.find(candidate => candidate && fs.existsSync(candidate));
  return installed || 'adb';
}

async function adbCommand(adb, args) {
  const result = await runFile(adb, args, { timeout: 6000, windowsHide: true, maxBuffer: 128 * 1024 });
  return result.stdout;
}

// Re-read the reverse mapping on every check: unplugging a cable or restarting
// adb removes it even when the same phone later returns with the same serial.
async function ensureBridge(adb, serial, execute = adbCommand) {
  const device = selectDevice(parseDevices(await execute(adb, ['devices', '-l'])), serial);
  if (device.state !== 'device') return device;
  const reverse = await execute(adb, ['-s', device.serial, 'reverse', '--list']);
  if (!hasLocalReverse(reverse)) {
    await execute(adb, ['-s', device.serial, 'reverse', 'tcp:3000', 'tcp:3000']);
    const verified = await execute(adb, ['-s', device.serial, 'reverse', '--list']);
    if (!hasLocalReverse(verified)) return { ...device, state: 'bridge-failed' };
  }
  return { ...device, state: 'connected' };
}

const deviceMessages = {
  connected: 'الهاتف متصل بالخادم المحلي. افتح KickSphere وحدّث المباريات.',
  disconnected: 'الهاتف غير متصل. وصّل USB؛ سيعاد الربط تلقائيًا دون إعادة تثبيت التطبيق.',
  unauthorized: 'افتح شاشة الهاتف ووافق على إذن USB debugging لهذا الكمبيوتر.',
  offline: 'اتصال الهاتف غير جاهز؛ افصل الكابل وأعد توصيله.',
  multiple: 'يوجد أكثر من هاتف. شغّل الملف مع --serial ثم رقم الهاتف المطلوب.',
  'bridge-failed': 'تعذّر إنشاء ربط USB. افحص الكابل وإذن USB debugging.',
};

async function main(args = process.argv.slice(2)) {
  const serialIndex = args.indexOf('--serial');
  const serial = serialIndex === -1 ? undefined : args[serialIndex + 1];
  if (serialIndex !== -1 && (!serial || !/^[\w.:-]+$/.test(serial))) {
    throw new Error('Use --serial followed by an Android device serial.');
  }
  if (args.some((arg, index) => arg !== '--check' && arg !== '--serial' &&
      !(serialIndex !== -1 && index === serialIndex + 1))) {
    throw new Error('Supported options: --check, --serial DEVICE.');
  }
  const adb = findAdb();
  if (args.includes('--check')) {
    const backend = await probeBackend();
    // Diagnostics do not change USB mappings or start an API process.
    const selected = selectDevice(parseDevices(await adbCommand(adb, ['devices', '-l'])), serial);
    const bridge = selected.state === 'device' && hasLocalReverse(
      await adbCommand(adb, ['-s', selected.serial, 'reverse', '--list'])
    );
    console.log(JSON.stringify({ backend, device: selected.state, usbBridge: Boolean(bridge),
      requiresComputerAndUsb: true, providerReachabilityChecked: false }));
    process.exitCode = backend === 'ready' && bridge ? 0 : 2;
    return;
  }

  let child;
  let stopping = false;
  const stop = () => {
    stopping = true;
    // Only the child started by this launcher belongs to it.
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let backend = await probeBackend();
    if (backend !== 'ready') {
      if (!await isPortFree()) {
        throw new Error('المنفذ 3000 مشغول أو الخادم غير جاهز. لم نوقف أي برنامج؛ أغلق نسخة التشغيل القديمة ثم حاول مجددًا.');
      }
      require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
      if (Buffer.byteLength(process.env.JWT_SECRET || '') < 32) {
        throw new Error('يلزم JWT_SECRET ثابت في ملف الخادم .env قبل التشغيل للحفاظ على جلسات الدخول.');
      }
      const logDirectory = path.join(root, 'logs');
      fs.mkdirSync(logDirectory, { recursive: true });
      const logPath = path.join(logDirectory, 'local-android-runtime.log');
      const log = fs.openSync(logPath, 'a');
      try {
        child = spawn(process.execPath, [path.join(root, 'server.js')], {
          cwd: root, windowsHide: true, stdio: ['ignore', log, log],
          env: { ...process.env, NODE_ENV: 'development', PORT: '3000' },
        });
      } finally {
        fs.closeSync(log);
      }
      let spawnFailed = false;
      child.once('error', () => { spawnFailed = true; });
      console.log('جارٍ تشغيل خادم KickSphere المحلي...');
      const startupDeadline = Date.now() + 90000;
      let nextStartupMessage = Date.now() + 10000;
      while (Date.now() < startupDeadline && !stopping) {
        if (spawnFailed || child.exitCode !== null) break;
        backend = await probeBackend();
        if (backend === 'ready') break;
        if (Date.now() >= nextStartupMessage) {
          console.log('ما زال الخادم يحمّل مكوّناته؛ لا يلزم تسجيل دخول جديد.');
          nextStartupMessage = Date.now() + 10000;
        }
        await pause(500);
      }
      if (stopping) return;
      if (backend !== 'ready') throw new Error(`تعذّر تشغيل الخادم. راجع سجل التشغيل المحلي: ${logPath}`);
    }
    console.log('الخادم المحلي جاهز. أبقِ هذه النافذة والكمبيوتر مفتوحين أثناء التجربة.');
    console.log('فصل USB أو نوم الكمبيوتر يوقف وصول البيانات. الاستضافة الخارجية مطلوبة للعمل المستقل.');
    console.log('للإيقاف اضغط Ctrl+C. لن يتغيّر تسجيل الدخول أو بيانات التطبيق.');
    let lastState;
    let nextHealthCheck = Date.now() + 30000;
    while (!stopping) {
      try {
        const device = await ensureBridge(adb, serial);
        const state = `${device.state}:${device.serial || ''}`;
        if (state !== lastState) {
          console.log(deviceMessages[device.state]);
          lastState = state;
        }
      } catch (_) {
        if (lastState !== 'adb-error') console.log('تعذّر قراءة الهاتف. تحقق من تثبيت Android platform-tools ومن اتصال USB.');
        lastState = 'adb-error';
      }
      if (Date.now() >= nextHealthCheck) {
        backend = await probeBackend();
        if (backend !== 'ready') throw new Error('توقف الخادم المحلي. أعد فتح ملف تشغيل KickSphere؛ لم تتغيّر بيانات هاتفك.');
        nextHealthCheck = Date.now() + 30000;
      }
      if (child && child.exitCode !== null) throw new Error('توقف الخادم المحلي. راجع سجل التشغيل ثم أعد فتح هذا الملف.');
      await pause(5000);
    }
  } finally {
    stop();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

module.exports = { parseDevices, selectDevice, hasLocalReverse, isPortFree, probeBackend, ensureBridge };
if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
