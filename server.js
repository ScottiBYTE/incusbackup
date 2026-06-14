// ScottiBYTE Incus Backup
// Install: npm install express multer
// Run: node --check server.js && node server.js

const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const APP_VERSION = process.env.APP_VERSION || process.env.npm_package_version || 'development';

const PORT = Number(process.env.PORT || 3030);
const BACKUP_DIR = process.env.INCUS_BACKUP_DIR || path.join(__dirname, 'backups');
const UPLOAD_DIR = path.join(BACKUP_DIR, '.uploads');
const METADATA_FILE = path.join(BACKUP_DIR, 'metadata.json');
const SETTINGS_FILE = path.join(BACKUP_DIR, 'settings.json');
const INVENTORY_CACHE_MS = Number(process.env.INCUS_INVENTORY_CACHE_MS || 30000);
const COMPLETED_JOB_TTL_MS = Number(process.env.INCUS_COMPLETED_JOB_TTL_MS || 180000);
const SCHEDULER_INTERVAL_MS = Number(process.env.INCUS_SCHEDULER_INTERVAL_MS || 60000);
const SCHEDULED_BACKUP_CONCURRENCY = Math.max(1, Number(process.env.INCUS_SCHEDULED_BACKUP_CONCURRENCY || 1));
const SELF_INSTANCE_NAME = process.env.INCUS_BACKUP_SELF_INSTANCE || 'IncusBackup';

fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/backups', express.static(BACKUP_DIR));

const upload = multer({ dest: UPLOAD_DIR });
const jobs = new Map();
const remoteInstanceCache = new Map();
let systemEvents = [];

let schedulerTimer = null;
let schedulerBusy = false;
let scheduledBackupRunning = 0;
const scheduledBackupQueue = [];
const scheduledQueuedKeys = new Set();
const scheduledRunningKeys = new Set();

function runIncus(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('incus', args, {
      timeout: options.timeout === 0 ? 0 : options.timeout || 30000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 50,
    }, (error, stdout, stderr) => {
      if (error) {
        reject({ message: error.message, stdout, stderr, code: error.code });
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

function safeName(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}

function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds || 0)));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function getFileSizeBytes(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function backupFileName(remote, instanceName) {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  return safeName(remote) + '--' + safeName(instanceName) + '--' + now + '.tar.gz';
}

function addSystemEvent(level, message) {
  systemEvents.unshift({
    level,
    message,
    at: new Date().toISOString(),
  });
  systemEvents = systemEvents.slice(0, 50);
}

function readMetadata() {
  try {
    if (!fs.existsSync(METADATA_FILE)) return { backups: {} };
    const parsed = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    if (!parsed.backups) parsed.backups = {};
    return parsed;
  } catch {
    return { backups: {} };
  }
}

function writeMetadata(metadata) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

function defaultSettings() {
  return { instancePolicies: {} };
}

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return defaultSettings();
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      ...defaultSettings(),
      ...parsed,
      instancePolicies: parsed.instancePolicies || {},
    };
  } catch {
    return defaultSettings();
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function instancePolicyKey(remote, instance) {
  return String(remote || '') + ':' + String(instance || '');
}

function isSelfInstance(instance) {
  return String(instance || '').toLowerCase() === String(SELF_INSTANCE_NAME || 'IncusBackup').toLowerCase();
}

function safeBackupModeForInstance(instance, requestedMode) {
  const mode = ['live', 'stop-restart'].includes(String(requestedMode || '')) ? String(requestedMode) : 'live';

  if (isSelfInstance(instance) && mode === 'stop-restart') {
    addSystemEvent('warn', 'Self-protection: forced ' + SELF_INSTANCE_NAME + ' backup mode to Live to avoid stopping the backup application.');
    return 'live';
  }

  return mode;
}

function pruneStaleInstancePolicies(settings, instances) {
  const activeKeys = new Set(instances.map((item) => instancePolicyKey(item.remote, item.name)));

  for (const key of Object.keys(settings.instancePolicies || {})) {
    if (!activeKeys.has(key)) delete settings.instancePolicies[key];
  }

  return settings;
}

function updateBackupMetadata(file, patch) {
  const metadata = readMetadata();
  metadata.backups[file] = {
    ...(metadata.backups[file] || {}),
    ...patch,
    file,
    updatedAt: new Date().toISOString(),
  };
  writeMetadata(metadata);
}

function removeBackupMetadata(file) {
  const metadata = readMetadata();
  delete metadata.backups[file];
  writeMetadata(metadata);
}

function getAgeInfo(modifiedIso) {
  const ageDays = Math.floor((Date.now() - new Date(modifiedIso).getTime()) / 86400000);
  let status = 'fresh';
  if (ageDays > 30) status = 'old';
  else if (ageDays > 7) status = 'aging';
  return { ageDays, status };
}

function getBackupFiles() {
  const metadata = readMetadata();
  return fs.readdirSync(BACKUP_DIR)
    .filter((file) => file.endsWith('.tar.gz'))
    .map((file) => {
      const fullPath = path.join(BACKUP_DIR, file);
      const stat = fs.statSync(fullPath);
      const modified = stat.mtime.toISOString();
      const age = getAgeInfo(modified);
      return {
        name: file,
        sizeBytes: stat.size,
        size: formatBytes(stat.size),
        modified,
        ageDays: age.ageDays,
        ageStatus: age.status,
        url: '/backups/' + encodeURIComponent(file),
        metadata: metadata.backups[file] || {},
      };
    })
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function createJob(type, title, details = {}) {
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const job = {
    id,
    type,
    title,
    status: 'running',
    phase: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    message: 'Queued',
    bytesWritten: 0,
    bytesWrittenHuman: '0 B',
    elapsedSeconds: 0,
    elapsedHuman: '00:00:00',
    result: null,
    error: null,
    ...details,
  };
  jobs.set(id, job);
  addSystemEvent('info', title + ' queued');
  return job;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;

  const previousStatus = job.status;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });

  if (patch.status === 'completed' && previousStatus !== 'completed') {
    job.completedAt = new Date().toISOString();
    addSystemEvent('success', job.message || job.title + ' completed');
  }

  if (patch.status === 'failed' && previousStatus !== 'failed') {
    job.completedAt = new Date().toISOString();
    addSystemEvent('error', (job.title || 'Job') + ' failed: ' + (job.error || job.message || 'Unknown error'));
  }
}

function cleanupExpiredJobs() {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    if (job.status === 'completed' && job.completedAt) {
      const age = now - new Date(job.completedAt).getTime();
      if (age > COMPLETED_JOB_TTL_MS) jobs.delete(id);
    }
  }
}

function recentJobs() {
  cleanupExpiredJobs();

  return Array.from(jobs.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);
}

async function getRemotes() {
  const output = await runIncus(['remote', 'list', '--format', 'json'], { timeout: 10000 });
  const data = JSON.parse(output || '{}');
  const remotes = [];

  for (const [name, info] of Object.entries(data)) {
    const protocol = info.Protocol || info.protocol || '';
    const addr = info.Addr || info.addr || '';
    const isPublic = Boolean(info.Public || info.public);

    if (protocol !== 'incus') continue;
    if (addr === 'unix://') continue;
    if (isPublic) continue;
    if (['images', 'ubuntu', 'ubuntu-daily'].includes(name)) continue;

    remotes.push({
      name,
      addr,
      protocol,
      authType: info.AuthType || info.authType || '',
      project: info.Project || info.project || 'default',
      public: isPublic,
      static: Boolean(info.Static || info.static),
      global: Boolean(info.Global || info.global),
    });
  }

  return remotes.sort((a, b) => a.name.localeCompare(b.name));
}

async function listInstancesForRemote(remoteName) {
  const cached = remoteInstanceCache.get(remoteName);
  if (cached && Date.now() - cached.createdAt < INVENTORY_CACHE_MS) {
    return cached.instances;
  }

  console.log('Scanning remote:', remoteName);
  const output = await runIncus(
    ['query', remoteName + ':/1.0/instances?recursion=1'],
    { timeout: 30000, maxBuffer: 1024 * 1024 * 50 }
  );

  const rawInstances = JSON.parse(output || '[]');
  const mapped = rawInstances.map((item) => ({
    remote: remoteName,
    name: item.name || '',
    status: item.status || 'Unknown',
    type: item.type || 'instance',
    architecture: item.architecture || '',
    created_at: item.created_at || '',
    last_used_at: item.last_used_at || '',
    location: item.location || '',
    project: item.project || 'default',
    profiles: Array.isArray(item.profiles) ? item.profiles : [],
    stateful: Boolean(item.stateful),
  }));

  remoteInstanceCache.set(remoteName, { createdAt: Date.now(), instances: mapped });
  return mapped;
}

function parseVersionText(output) {
  const text = String(output || '').replaceAll('\r', '');
  for (const line of text.split('\n')) {
    const lower = line.toLowerCase();
    if (lower.includes('server version:')) return line.split(':').slice(1).join(':').trim();
    if (lower.includes('server_version:')) return line.split(':').slice(1).join(':').replaceAll('"', '').trim();
  }
  return 'version unknown';
}

async function getRemoteServerInfo(remoteName) {
  try {
    const output = await runIncus(['version', remoteName + ':'], {
      timeout: 8000,
      maxBuffer: 1024 * 1024 * 5,
    });
    const version = parseVersionText(output);
    if (version !== 'version unknown') return { serverVersion: version, apiStatus: 'ok' };
  } catch {}

  try {
    const output = await runIncus(['info', remoteName + ':', '--format', 'json'], {
      timeout: 8000,
      maxBuffer: 1024 * 1024 * 5,
    });
    const parsed = JSON.parse(output || '{}');
    const environment = parsed.environment || (parsed.metadata && parsed.metadata.environment) || {};
    const version =
      environment.server_version ||
      environment.serverVersion ||
      parsed.server_version ||
      parsed.serverVersion ||
      (parsed.metadata && parsed.metadata.server_version) ||
      'version unknown';

    if (version !== 'version unknown') return { serverVersion: version, apiStatus: 'ok' };
  } catch {}

  try {
    const output = await runIncus(['query', remoteName + ':/1.0'], {
      timeout: 8000,
      maxBuffer: 1024 * 1024 * 5,
    });
    const parsed = JSON.parse(output || '{}');
    const metadata = parsed.metadata || {};
    const environment = metadata.environment || {};
    return {
      serverVersion:
        environment.server_version ||
        environment.serverVersion ||
        metadata.server_version ||
        metadata.serverVersion ||
        metadata.api_version ||
        'version unknown',
      apiStatus: parsed.status || 'ok',
    };
  } catch (err) {
    return {
      serverVersion: 'offline',
      apiStatus: 'unreachable',
      error: err.stderr || err.message,
    };
  }
}

async function checkRemote(remote) {
  const started = Date.now();

  try {
    const info = await getRemoteServerInfo(remote.name);
    if (info.apiStatus === 'unreachable') throw new Error(info.error || 'Remote unreachable');

    const instances = await listInstancesForRemote(remote.name);
    const containerCount = instances.filter((item) => item.type === 'container').length;
    const vmCount = instances.filter((item) => item.type === 'virtual-machine').length;
    const runningCount = instances.filter((item) => item.status === 'Running').length;
    const stoppedCount = instances.filter((item) => item.status === 'Stopped').length;

    return {
      ...remote,
      reachable: true,
      latencyMs: Date.now() - started,
      serverVersion: info.serverVersion,
      apiStatus: info.apiStatus,
      instanceCount: instances.length,
      containerCount,
      vmCount,
      runningCount,
      stoppedCount,
      error: null,
    };
  } catch (err) {
    return {
      ...remote,
      reachable: false,
      latencyMs: Date.now() - started,
      serverVersion: 'offline',
      apiStatus: 'unreachable',
      instanceCount: 0,
      containerCount: 0,
      vmCount: 0,
      runningCount: 0,
      stoppedCount: 0,
      error: err.stderr || err.message,
    };
  }
}

async function getInstanceStatus(remote, instance) {
  try {
    const output = await runIncus(
      ['query', remote + ':/1.0/instances/' + encodeURIComponent(instance) + '/state'],
      { timeout: 10000, maxBuffer: 1024 * 1024 * 5 }
    );
    const parsed = JSON.parse(output || '{}');
    return parsed.status || (parsed.metadata && parsed.metadata.status) || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

async function instanceExists(remote, instance) {
  try {
    await runIncus(['info', remote + ':' + instance], {
      timeout: 15000,
      maxBuffer: 1024 * 1024 * 10,
    });
    return true;
  } catch {
    return false;
  }
}

async function stopInstance(remote, instance, jobId) {
  updateJob(jobId, {
    phase: 'stopping',
    message: 'Stopping instance before export: ' + remote + ':' + instance,
  });

  await runIncus(['stop', remote + ':' + instance, '--timeout', '120'], {
    timeout: 180000,
    maxBuffer: 1024 * 1024 * 10,
  });

  remoteInstanceCache.delete(remote);

  updateJob(jobId, {
    phase: 'stopped',
    message: 'Instance stopped. Starting export archive: ' + remote + ':' + instance,
  });
}

async function startInstance(remote, instance, jobId) {
  updateJob(jobId, {
    phase: 'restarting',
    message: 'Restarting instance after export: ' + remote + ':' + instance,
  });

  await runIncus(['start', remote + ':' + instance], {
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 10,
  });

  remoteInstanceCache.delete(remote);
}


function normalizeServerSchedule(schedule) {
  schedule = schedule || {};
  const rawFrequency = ['off', 'hourly', 'daily', 'weekly', 'monthly'].includes(schedule.frequency)
    ? schedule.frequency
    : 'off';
  const enabled = Boolean(schedule.enabled) && rawFrequency !== 'off';
  const frequency = enabled ? rawFrequency : 'off';

  return {
    enabled,
    frequency,
    everyHours: Math.max(1, Math.min(168, Number(schedule.everyHours || 24))),
    time: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(String(schedule.time || '')) ? String(schedule.time) : '02:00',
    dayOfWeek: Math.max(0, Math.min(6, Number(schedule.dayOfWeek ?? 0))),
    dayOfMonth: Math.max(1, Math.min(31, Number(schedule.dayOfMonth || 1))),
    retentionCount: Math.max(1, Math.min(365, Number(schedule.retentionCount || 7))),
    runMissed: Boolean(schedule.runMissed),
    lastRunSlot: String(schedule.lastRunSlot || ''),
    lastQueuedAt: schedule.lastQueuedAt || null,
    lastStartedAt: schedule.lastStartedAt || null,
    lastFinishedAt: schedule.lastFinishedAt || null,
    lastStatus: schedule.lastStatus || null,
    lastError: schedule.lastError || null,
    lastJobId: schedule.lastJobId || null,
  };
}

function schedulerPad(value) {
  return String(value).padStart(2, '0');
}

function schedulerYmd(date) {
  return date.getFullYear() + '-' + schedulerPad(date.getMonth() + 1) + '-' + schedulerPad(date.getDate());
}

function schedulerTimeParts(value) {
  const parts = String(value || '02:00').split(':');
  return [
    Math.max(0, Math.min(23, Number(parts[0] || 2))),
    Math.max(0, Math.min(59, Number(parts[1] || 0))),
  ];
}

function schedulerMinuteDate(date) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

function schedulerLastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function schedulerSlotKey(schedule, date) {
  const d = schedulerMinuteDate(date);
  if (schedule.frequency === 'hourly') {
    return 'hourly:' + schedulerYmd(d) + 'T' + schedulerPad(d.getHours());
  }

  const [h, m] = schedulerTimeParts(schedule.time);
  return schedule.frequency + ':' + schedulerYmd(d) + 'T' + schedulerPad(h) + ':' + schedulerPad(m);
}

function schedulerBuildDateLike(baseDate, hour, minute) {
  const d = new Date(baseDate);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function schedulerDueNow(schedule, now) {
  const current = schedulerMinuteDate(now);

  if (!schedule.enabled || schedule.frequency === 'off') return null;

  if (schedule.frequency === 'hourly') {
    if (current.getMinutes() !== 0) return null;
    if ((current.getHours() % schedule.everyHours) !== 0) return null;
    return { date: current, slotKey: schedulerSlotKey(schedule, current), missed: false };
  }

  const [hour, minute] = schedulerTimeParts(schedule.time);
  if (current.getHours() !== hour || current.getMinutes() !== minute) return null;

  if (schedule.frequency === 'daily') {
    return { date: current, slotKey: schedulerSlotKey(schedule, current), missed: false };
  }

  if (schedule.frequency === 'weekly') {
    if (current.getDay() !== schedule.dayOfWeek) return null;
    return { date: current, slotKey: schedulerSlotKey(schedule, current), missed: false };
  }

  if (schedule.frequency === 'monthly') {
    const targetDay = Math.min(schedule.dayOfMonth, schedulerLastDayOfMonth(current.getFullYear(), current.getMonth()));
    if (current.getDate() !== targetDay) return null;
    return { date: current, slotKey: schedulerSlotKey(schedule, current), missed: false };
  }

  return null;
}

function schedulerMostRecentDue(schedule, now) {
  const current = schedulerMinuteDate(now);

  if (!schedule.enabled || schedule.frequency === 'off') return null;

  if (schedule.frequency === 'hourly') {
    const candidate = new Date(current);
    candidate.setMinutes(0, 0, 0);

    while ((candidate.getHours() % schedule.everyHours) !== 0) {
      candidate.setHours(candidate.getHours() - 1);
    }

    return { date: candidate, slotKey: schedulerSlotKey(schedule, candidate), missed: true };
  }

  const [hour, minute] = schedulerTimeParts(schedule.time);

  if (schedule.frequency === 'daily') {
    const candidate = schedulerBuildDateLike(current, hour, minute);
    if (candidate > current) candidate.setDate(candidate.getDate() - 1);
    return { date: candidate, slotKey: schedulerSlotKey(schedule, candidate), missed: true };
  }

  if (schedule.frequency === 'weekly') {
    const candidate = schedulerBuildDateLike(current, hour, minute);
    const daysBack = (candidate.getDay() - schedule.dayOfWeek + 7) % 7;
    candidate.setDate(candidate.getDate() - daysBack);
    if (candidate > current) candidate.setDate(candidate.getDate() - 7);
    return { date: candidate, slotKey: schedulerSlotKey(schedule, candidate), missed: true };
  }

  if (schedule.frequency === 'monthly') {
    let candidate = new Date(current);
    const targetDay = Math.min(schedule.dayOfMonth, schedulerLastDayOfMonth(candidate.getFullYear(), candidate.getMonth()));
    candidate.setDate(targetDay);
    candidate.setHours(hour, minute, 0, 0);

    if (candidate > current) {
      candidate = new Date(current.getFullYear(), current.getMonth() - 1, 1, hour, minute, 0, 0);
      const previousTargetDay = Math.min(schedule.dayOfMonth, schedulerLastDayOfMonth(candidate.getFullYear(), candidate.getMonth()));
      candidate.setDate(previousTargetDay);
    }

    return { date: candidate, slotKey: schedulerSlotKey(schedule, candidate), missed: true };
  }

  return null;
}

function schedulerMissWindowMs(schedule) {
  if (schedule.frequency === 'hourly') return Math.max(2, schedule.everyHours + 1) * 3600000;
  if (schedule.frequency === 'daily') return 36 * 3600000;
  if (schedule.frequency === 'weekly') return 8 * 86400000;
  if (schedule.frequency === 'monthly') return 32 * 86400000;
  return 0;
}

function schedulerDueSlot(schedule, now) {
  const due = schedulerDueNow(schedule, now);
  if (due && schedule.lastRunSlot !== due.slotKey) return due;

  if (!schedule.runMissed) return null;

  const missed = schedulerMostRecentDue(schedule, now);
  if (!missed) return null;
  if (schedule.lastRunSlot === missed.slotKey) return null;

  const age = schedulerMinuteDate(now).getTime() - missed.date.getTime();
  if (age <= 0) return null;
  if (age > schedulerMissWindowMs(schedule)) return null;

  return missed;
}

function schedulerPatchSchedule(remote, instance, patch) {
  const settings = readSettings();
  const key = instancePolicyKey(remote, instance);
  const existing = (settings.instancePolicies || {})[key];

  if (!existing) return;

  settings.instancePolicies[key] = {
    ...existing,
    remote,
    instance,
    schedule: {
      ...(existing.schedule || {}),
      ...patch,
      schedulerUpdatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };

  writeSettings(settings);
}

function scheduledJobAlreadyRunning(remote, instance) {
  return Array.from(jobs.values()).some((job) =>
    job.status === 'running' &&
    job.sourceRemote === remote &&
    job.sourceInstance === instance
  );
}

function scheduledBackupKey(remote, instance) {
  return instancePolicyKey(remote, instance);
}

function queueScheduledBackup(remote, instance, policy, schedule, due) {
  const key = scheduledBackupKey(remote, instance);

  if (scheduledQueuedKeys.has(key) || scheduledRunningKeys.has(key) || scheduledJobAlreadyRunning(remote, instance)) {
    return;
  }

  const requestedBackupMode = ['live', 'stop-restart'].includes(policy.backupMode) ? policy.backupMode : 'live';
  const backupMode = safeBackupModeForInstance(instance, requestedBackupMode);
  const exportScope = ['instance-only', 'include-snapshots'].includes(policy.exportScope) ? policy.exportScope : 'instance-only';

  scheduledQueuedKeys.add(key);
  scheduledBackupQueue.push({
    key,
    remote,
    instance,
    backupMode,
    exportScope,
    retentionCount: schedule.retentionCount,
    slotKey: due.slotKey,
    missed: Boolean(due.missed),
  });

  schedulerPatchSchedule(remote, instance, {
    lastRunSlot: due.slotKey,
    lastQueuedAt: new Date().toISOString(),
    lastStatus: 'queued',
    lastError: null,
  });

  addSystemEvent(
    'info',
    'Scheduled backup queued for ' + remote + ':' + instance + (due.missed ? ' (missed run)' : '')
  );

  processScheduledBackupQueue();
}

async function waitForScheduledJob(jobId) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const job = jobs.get(jobId);

      if (!job) return;

      if (job.status !== 'running') {
        clearInterval(timer);
        resolve(job);
      }
    }, 5000);
  });
}

function enforceScheduledRetention(remote, instance, retentionCount) {
  retentionCount = Math.max(1, Math.min(365, Number(retentionCount || 7)));

  const files = getBackupFiles()
    .filter((file) => {
      const m = file.metadata || {};
      return m.sourceRemote === remote && m.sourceInstance === instance;
    })
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));

  const remove = files.slice(retentionCount);

  for (const file of remove) {
    const fullPath = path.join(BACKUP_DIR, file.name);

    try {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      removeBackupMetadata(file.name);
      addSystemEvent('info', 'Retention removed old backup ' + file.name);
    } catch (err) {
      addSystemEvent('error', 'Retention failed for ' + file.name + ': ' + err.message);
    }
  }
}

function processScheduledBackupQueue() {
  while (scheduledBackupRunning < SCHEDULED_BACKUP_CONCURRENCY && scheduledBackupQueue.length > 0) {
    const task = scheduledBackupQueue.shift();

    scheduledQueuedKeys.delete(task.key);
    scheduledRunningKeys.add(task.key);
    scheduledBackupRunning += 1;

    (async () => {
      let jobId = null;

      try {
        const response = await fetch('http://127.0.0.1:' + PORT + '/api/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            remote: task.remote,
            instance: task.instance,
            backupMode: task.backupMode,
            exportScope: task.exportScope,
          }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.ok) {
          throw new Error(data.error || ('Scheduled export request failed with HTTP ' + response.status));
        }

        jobId = data.jobId;

        schedulerPatchSchedule(task.remote, task.instance, {
          lastStartedAt: new Date().toISOString(),
          lastStatus: 'running',
          lastError: null,
          lastJobId: jobId,
        });

        addSystemEvent('info', 'Scheduled backup started for ' + task.remote + ':' + task.instance);

        const job = await waitForScheduledJob(jobId);

        schedulerPatchSchedule(task.remote, task.instance, {
          lastFinishedAt: new Date().toISOString(),
          lastStatus: job.status,
          lastError: job.status === 'failed' ? (job.error || job.message || 'Scheduled backup failed') : null,
          lastJobId: jobId,
        });

        if (job.status === 'completed') {
          enforceScheduledRetention(task.remote, task.instance, task.retentionCount);
        }
      } catch (err) {
        schedulerPatchSchedule(task.remote, task.instance, {
          lastFinishedAt: new Date().toISOString(),
          lastStatus: 'failed',
          lastError: err.message || String(err),
          lastJobId: jobId,
        });

        addSystemEvent('error', 'Scheduled backup failed for ' + task.remote + ':' + task.instance + ': ' + (err.message || String(err)));
      } finally {
        scheduledRunningKeys.delete(task.key);
        scheduledBackupRunning = Math.max(0, scheduledBackupRunning - 1);
        processScheduledBackupQueue();
      }
    })();
  }
}

async function schedulerTick() {
  if (schedulerBusy) return;

  schedulerBusy = true;

  try {
    const settings = readSettings();
    const now = new Date();

    for (const [key, policy] of Object.entries(settings.instancePolicies || {})) {
      const splitAt = key.indexOf(':');
      const remote = policy.remote || (splitAt >= 0 ? key.slice(0, splitAt) : '');
      const instance = policy.instance || (splitAt >= 0 ? key.slice(splitAt + 1) : '');

      if (!remote || !instance) continue;

      const schedule = normalizeServerSchedule(policy.schedule);

      if (!schedule.enabled) continue;

      const due = schedulerDueSlot(schedule, now);

      if (!due) continue;

      queueScheduledBackup(remote, instance, policy, schedule, due);
    }
  } catch (err) {
    addSystemEvent('error', 'Scheduler tick failed: ' + (err.message || String(err)));
  } finally {
    schedulerBusy = false;
  }
}

function startScheduler() {
  if (schedulerTimer) return;

  schedulerTimer = setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);

  setTimeout(() => {
    schedulerTick();
  }, 5000);

  console.log(
    'Scheduled backup engine active. Interval ' +
    Math.round(SCHEDULER_INTERVAL_MS / 1000) +
    ' seconds. Concurrency ' +
    SCHEDULED_BACKUP_CONCURRENCY +
    '.'
  );

  addSystemEvent('info', 'Scheduled backup engine started');
}


app.get('/api/health', async (req, res) => {
  try {
    const version = await runIncus(['version'], { timeout: 10000 });
    const remotes = await getRemotes();
    const checked = [];

    for (const remote of remotes) checked.push(await checkRemote(remote));

    const backupFiles = getBackupFiles();
    const currentJobs = recentJobs();

    const totals = {
      remotes: checked.length,
      reachableRemotes: checked.filter((remote) => remote.reachable).length,
      instances: checked.reduce((sum, remote) => sum + (remote.instanceCount || 0), 0),
      containers: checked.reduce((sum, remote) => sum + (remote.containerCount || 0), 0),
      virtualMachines: checked.reduce((sum, remote) => sum + (remote.vmCount || 0), 0),
      running: checked.reduce((sum, remote) => sum + (remote.runningCount || 0), 0),
      stopped: checked.reduce((sum, remote) => sum + (remote.stoppedCount || 0), 0),
      backups: backupFiles.length,
      activeJobs: currentJobs.filter((job) => job.status === 'running').length,
      failedJobs: currentJobs.filter((job) => job.status === 'failed').length,
    };

    res.json({ ok: true, version: APP_VERSION, incus: version, backupDir: BACKUP_DIR, remotes: checked, totals });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.stderr || err.message });
  }
});

app.get('/api/instances', async (req, res) => {
  try {
    const remotes = await getRemotes();
    const instances = [];
    const errors = [];

    for (const remote of remotes) {
      try {
        instances.push(...await listInstancesForRemote(remote.name));
      } catch (err) {
        errors.push({ remote: remote.name, error: err.stderr || err.message });
      }
    }

    instances.sort((a, b) => a.remote.localeCompare(b.remote) || a.name.localeCompare(b.name));

    const settings = pruneStaleInstancePolicies(readSettings(), instances);
    writeSettings(settings);

    res.json({ ok: true, remotes, instances, errors, settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.stderr || err.message });
  }
});

app.get('/api/backups', (req, res) => {
  try {
    res.json({ ok: true, backupDir: BACKUP_DIR, files: getBackupFiles() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/jobs', (req, res) => {
  res.json({ ok: true, jobs: recentJobs(), events: systemEvents });
});

app.get('/api/settings', (req, res) => {
  res.json({ ok: true, settings: readSettings() });
});

app.post('/api/settings/instance-policy', (req, res) => {
  const remote = safeName(req.body.remote);
  const instance = safeName(req.body.instance);
  const backupMode = String(req.body.backupMode || '');
  const exportScope = String(req.body.exportScope || '');

  if (!remote) return res.status(400).json({ ok: false, error: 'Missing remote name.' });
  if (!instance) return res.status(400).json({ ok: false, error: 'Missing instance name.' });

  const settings = readSettings();
  const key = instancePolicyKey(remote, instance);
  const existing = settings.instancePolicies[key] || {};

  const requestedBackupMode = backupMode || existing.backupMode || 'live';
  const nextBackupMode = safeBackupModeForInstance(instance, requestedBackupMode);
  const nextExportScope = exportScope || existing.exportScope || 'instance-only';

  if (!['live', 'stop-restart'].includes(nextBackupMode)) {
    return res.status(400).json({ ok: false, error: 'Invalid backup mode.' });
  }
  if (!['instance-only', 'include-snapshots'].includes(nextExportScope)) {
    return res.status(400).json({ ok: false, error: 'Invalid export scope.' });
  }

  let nextSchedule = existing.schedule || {
    enabled: false,
    frequency: 'off',
    everyHours: 24,
    time: '02:00',
    dayOfWeek: 0,
    dayOfMonth: 1,
    retentionCount: 7,
    runMissed: false,
  };

  if (req.body.schedule && typeof req.body.schedule === 'object') {
    const incoming = req.body.schedule;
    const frequency = String(incoming.frequency || nextSchedule.frequency || 'off');
    const time = String(incoming.time || nextSchedule.time || '02:00');
    const everyHours = Math.max(1, Math.min(168, Number(incoming.everyHours || nextSchedule.everyHours || 24)));
    const dayOfWeek = Math.max(0, Math.min(6, Number(incoming.dayOfWeek ?? nextSchedule.dayOfWeek ?? 0)));
    const dayOfMonth = Math.max(1, Math.min(31, Number(incoming.dayOfMonth || nextSchedule.dayOfMonth || 1)));
    const retentionCount = Math.max(1, Math.min(365, Number(incoming.retentionCount || nextSchedule.retentionCount || 7)));

    if (!['off', 'hourly', 'daily', 'weekly', 'monthly'].includes(frequency)) {
      return res.status(400).json({ ok: false, error: 'Invalid schedule frequency.' });
    }

    if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
      return res.status(400).json({ ok: false, error: 'Invalid schedule time. Use HH:MM.' });
    }

    nextSchedule = {
      enabled: Boolean(incoming.enabled) && frequency !== 'off',
      frequency,
      everyHours,
      time,
      dayOfWeek,
      dayOfMonth,
      retentionCount,
      runMissed: Boolean(incoming.runMissed),
      updatedAt: new Date().toISOString(),
    };
  }

  settings.instancePolicies[key] = {
    ...existing,
    remote,
    instance,
    backupMode: nextBackupMode,
    exportScope: nextExportScope,
    schedule: nextSchedule,
    updatedAt: new Date().toISOString(),
  };

  writeSettings(settings);
  res.json({ ok: true, settings });
});

app.post('/api/export', async (req, res) => {
  const remote = safeName(req.body.remote);
  const instance = safeName(req.body.instance);
  const backupMode = safeBackupModeForInstance(instance, String(req.body.backupMode || 'live'));
  const exportScope = String(req.body.exportScope || 'instance-only');

  if (!remote) return res.status(400).json({ ok: false, error: 'Missing remote name.' });
  if (!instance) return res.status(400).json({ ok: false, error: 'Missing instance name.' });
  if (!['live', 'stop-restart'].includes(backupMode)) {
    return res.status(400).json({ ok: false, error: 'Invalid backup mode.' });
  }
  if (!['instance-only', 'include-snapshots'].includes(exportScope)) {
    return res.status(400).json({ ok: false, error: 'Invalid export scope.' });
  }

  const filename = backupFileName(remote, instance);
  const fullPath = path.join(BACKUP_DIR, filename);
  const partialPath = fullPath + '.partial';

  const job = createJob('export', 'Export ' + remote + ':' + instance, {
    sourceRemote: remote,
    sourceInstance: instance,
    backupMode,
    exportScope,
    phase: 'queued',
  });

  res.json({ ok: true, jobId: job.id, file: filename });

  (async () => {
    let shouldRestart = false;
    let originalStatus = 'Unknown';
    let progressTimer = null;

    function updateExportProgress() {
      const bytesWritten = getFileSizeBytes(partialPath);
      const elapsedSeconds = Math.floor((Date.now() - new Date(job.createdAt).getTime()) / 1000);

      updateJob(job.id, {
        bytesWritten,
        bytesWrittenHuman: formatBytes(bytesWritten),
        elapsedSeconds,
        elapsedHuman: formatDuration(elapsedSeconds),
      });
    }

    try {
      updateExportProgress();
      progressTimer = setInterval(updateExportProgress, 3000);

      originalStatus = await getInstanceStatus(remote, instance);

      if (backupMode === 'stop-restart' && originalStatus === 'Running') {
        shouldRestart = true;
        await stopInstance(remote, instance, job.id);
      }

      updateJob(job.id, {
        phase: 'exporting',
        message: 'Exporting archive: ' + filename,
      });

      try {
        if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
      } catch {}

      const exportArgs = ['export', remote + ':' + instance, partialPath];
      if (exportScope === 'instance-only') exportArgs.push('--instance-only');

      updateExportProgress();

      await runIncus(exportArgs, {
        timeout: 0,
        maxBuffer: 1024 * 1024 * 10,
      });

      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }

      if (!fs.existsSync(partialPath)) {
        throw new Error('Export completed but partial file was not created: ' + partialPath);
      }

      fs.renameSync(partialPath, fullPath);

      const stat = fs.statSync(fullPath);
      updateJob(job.id, {
        bytesWritten: stat.size,
        bytesWrittenHuman: formatBytes(stat.size),
      });

      updateBackupMetadata(filename, {
        sourceRemote: remote,
        sourceInstance: instance,
        createdBy: 'IncusBackup',
        exportedAt: new Date().toISOString(),
        backupMode,
        exportScope,
        originalStatus,
        sizeBytes: stat.size,
        size: formatBytes(stat.size),
      });

      if (shouldRestart) await startInstance(remote, instance, job.id);
      remoteInstanceCache.delete(remote);

      updateJob(job.id, {
        status: 'completed',
        phase: 'completed',
        message: 'Export complete: ' + filename,
        result: { file: filename, path: fullPath, size: formatBytes(stat.size), backupMode, exportScope },
      });
    } catch (err) {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }

      updateExportProgress();

      try {
        if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
      } catch {}

      if (shouldRestart) {
        try {
          await startInstance(remote, instance, job.id);
        } catch (restartErr) {
          updateJob(job.id, {
            phase: 'restart-failed',
            message: 'Backup failed and restart also failed: ' + (restartErr.stderr || restartErr.message),
          });
        }
      }

      remoteInstanceCache.delete(remote);

      updateJob(job.id, {
        status: 'failed',
        phase: 'failed',
        message: 'Export failed',
        error: err.stderr || err.message,
      });
    }
  })();
});

app.post('/api/replace', async (req, res) => {
  const file = path.basename(req.body.file || '');
  const remote = safeName(req.body.remote);
  const name = safeName(req.body.name);

  if (!file || !file.endsWith('.tar.gz')) return res.status(400).json({ ok: false, error: 'Missing or invalid .tar.gz backup file.' });
  if (!remote) return res.status(400).json({ ok: false, error: 'Missing destination remote.' });
  if (!name) return res.status(400).json({ ok: false, error: 'Missing original instance name.' });

  const fullPath = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ ok: false, error: 'Backup file not found.' });

  const holdName = safeName(name + '-replace-hold-' + Date.now().toString(36));

  const job = createJob('replace', 'Replace ' + remote + ':' + name + ' from ' + file, {
    sourceFile: file,
    destinationRemote: remote,
    destinationInstance: name,
    rollbackInstance: holdName,
  });

  res.json({ ok: true, jobId: job.id, replaced: remote + ':' + name });

  (async () => {
    let originalStatus = 'Unknown';
    let movedOriginal = false;
    let importedReplacement = false;

    try {
      if (!(await instanceExists(remote, name))) {
        throw new Error('Original instance does not exist on ' + remote + ': ' + name);
      }

      originalStatus = await getInstanceStatus(remote, name);

      if (originalStatus === 'Running') {
        updateJob(job.id, { phase: 'stopping', message: 'Stopping original before replace: ' + remote + ':' + name });
        await runIncus(['stop', remote + ':' + name, '--timeout', '120'], {
          timeout: 180000,
          maxBuffer: 1024 * 1024 * 10,
        });
      }

      updateJob(job.id, { phase: 'holding-original', message: 'Moving original to rollback hold: ' + remote + ':' + holdName });
      await runIncus(['move', remote + ':' + name, remote + ':' + holdName], {
        timeout: 180000,
        maxBuffer: 1024 * 1024 * 10,
      });
      movedOriginal = true;

      // Avoid MAC collision between held original and imported replacement.
      try {
        const randomMac = '00:16:3e:' + Array.from({ length: 3 }, () =>
          Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
        ).join(':');
        await runIncus(['config', 'set', remote + ':' + holdName, 'volatile.eth0.hwaddr=' + randomMac], {
          timeout: 30000,
          maxBuffer: 1024 * 1024 * 10,
        });
      } catch {}

      updateJob(job.id, { phase: 'importing', message: 'Importing replacement as original name: ' + remote + ':' + name });

      // Correct syntax: incus import <remote>: <backup file> <instance name>
      await runIncus(['import', remote + ':', fullPath, name], {
        timeout: 0,
        maxBuffer: 1024 * 1024 * 10,
      });
      importedReplacement = true;

      if (originalStatus === 'Running') {
        updateJob(job.id, { phase: 'starting', message: 'Starting replaced instance: ' + remote + ':' + name });
        await runIncus(['start', remote + ':' + name], {
          timeout: 120000,
          maxBuffer: 1024 * 1024 * 10,
        });
      }

      updateJob(job.id, { phase: 'cleanup', message: 'Deleting rollback hold after successful replace: ' + remote + ':' + holdName });
      await runIncus(['delete', remote + ':' + holdName], {
        timeout: 180000,
        maxBuffer: 1024 * 1024 * 10,
      });

      remoteInstanceCache.delete(remote);

      updateJob(job.id, {
        status: 'completed',
        phase: 'completed',
        message: 'Replace complete: ' + remote + ':' + name,
        result: { replaced: remote + ':' + name },
      });
    } catch (err) {
      try {
        if (importedReplacement && await instanceExists(remote, name)) {
          await runIncus(['delete', remote + ':' + name], { timeout: 180000, maxBuffer: 1024 * 1024 * 10 });
        }

        if (movedOriginal && await instanceExists(remote, holdName) && !(await instanceExists(remote, name))) {
          await runIncus(['move', remote + ':' + holdName, remote + ':' + name], {
            timeout: 180000,
            maxBuffer: 1024 * 1024 * 10,
          });

          if (originalStatus === 'Running') {
            await runIncus(['start', remote + ':' + name], { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
          }
        }
      } catch {}

      remoteInstanceCache.delete(remote);

      updateJob(job.id, {
        status: 'failed',
        phase: 'failed',
        message: 'Replace failed. Rollback attempted.',
        error: err.stderr || err.message,
      });
    }
  })();
});

app.post('/api/import', async (req, res) => {
  const file = path.basename(req.body.file || '');
  const remote = safeName(req.body.remote);
  const newName = safeName(req.body.name);

  if (!file || !file.endsWith('.tar.gz')) return res.status(400).json({ ok: false, error: 'Missing or invalid .tar.gz backup file.' });
  if (!remote) return res.status(400).json({ ok: false, error: 'Missing destination remote.' });
  if (!newName) return res.status(400).json({ ok: false, error: 'Missing new container name.' });

  const fullPath = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ ok: false, error: 'Backup file not found.' });

  const job = createJob('import', 'Import ' + file + ' as ' + remote + ':' + newName, {
    sourceFile: file,
    destinationRemote: remote,
    destinationInstance: newName,
  });

  res.json({ ok: true, jobId: job.id, importedAs: remote + ':' + newName });

  (async () => {
    try {
      updateJob(job.id, { message: 'Importing ' + file + ' as ' + remote + ':' + newName });

      // Correct Incus remote import syntax:
      // incus import <remote>: <backup file> <instance name>
      await runIncus(['import', remote + ':', fullPath, newName], {
        timeout: 0,
        maxBuffer: 1024 * 1024 * 10,
      });

      try {
        await runIncus(['config', 'unset', remote + ':' + newName, 'volatile.eth0.hwaddr'], {
          timeout: 30000,
          maxBuffer: 1024 * 1024 * 10,
        });
      } catch {}

      remoteInstanceCache.delete(remote);

      updateJob(job.id, {
        status: 'completed',
        phase: 'completed',
        message: 'Import complete: ' + remote + ':' + newName,
        result: { importedAs: remote + ':' + newName },
      });
    } catch (err) {
      updateJob(job.id, {
        status: 'failed',
        phase: 'failed',
        message: 'Import failed',
        error: err.stderr || err.message,
      });
    }
  })();
});

app.post('/api/upload', upload.single('backup'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });

    const originalName = path.basename(req.file.originalname || 'backup.tar.gz');

    if (!originalName.endsWith('.tar.gz')) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ ok: false, error: 'Only .tar.gz files are allowed.' });
    }

    const destination = path.join(BACKUP_DIR, safeName(originalName.replace(/\.tar\.gz$/, '')) + '.tar.gz');
    fs.renameSync(req.file.path, destination);

    const stat = fs.statSync(destination);

    updateBackupMetadata(path.basename(destination), {
      uploadedAt: new Date().toISOString(),
      uploadedOriginalName: originalName,
      sizeBytes: stat.size,
      size: formatBytes(stat.size),
    });

    addSystemEvent('info', 'Uploaded backup file ' + path.basename(destination));
    res.json({ ok: true, file: path.basename(destination) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/backups/:file', (req, res) => {
  try {
    const file = path.basename(req.params.file || '');
    const fullPath = path.join(BACKUP_DIR, file);

    if (!file.endsWith('.tar.gz') || !fs.existsSync(fullPath)) {
      return res.status(404).json({ ok: false, error: 'Backup file not found.' });
    }

    fs.unlinkSync(fullPath);
    removeBackupMetadata(file);
    addSystemEvent('info', 'Deleted backup file ' + file);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const indexHtml = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ScottiBYTE Incus Backup</title>
  <link rel="stylesheet" href="/style.css?v=20260614s37" />
</head>
<body>
  <header>
    <div class="header-top">
      <div>
        <h1>ScottiBYTE Incus Backup</h1>
        <div class="sub">Centralized backup and restore for Incus containers and virtual machines across every remote available to this Incus client.</div>
      </div>
      <div class="header-actions">
        <a id="versionPill" class="header-pill version-pill" href="https://github.com/ScottiBYTE/incusbackup/releases" target="_blank">vdevelopment</a>
        <a id="donateButton" class="header-pill donate-pill" href="https://www.paypal.com/paypalme/ScottiBYTE" target="_blank" rel="noopener noreferrer" title="Support ScottiBYTE Incus Backup development">❤️ Donate</a>
        <button id="themeToggle" class="header-pill theme-pill" type="button">☀ Light</button>
      </div>
    </div>
  </header>

  <main>
    <section>
      <h2>Status</h2>
      <div class="row">
        <button id="refreshButton">Refresh</button>
<span id="lastRefreshTime" class="small" style="margin-left:10px;">Last refreshed: Never</span>
        <span id="health" class="muted">Checking Incus client...</span>
      </div>

      <div class="status-grid">
        <div class="stat-card" style="display:flex;align-items:center;gap:16px;padding:14px 18px;min-height:78px;"><div class="stat-icon control" style="width:56px;
min-width:56px;
font-size:40px;
line-height:1;
text-align:center;
display:flex;
align-items:center;
justify-content:center;">🗄️</div><div class="stat-text" style="display:flex;flex-direction:column;justify-content:center;gap:4px;"><div class="stat-label">Control Node</div><div id="clientStatus" class="stat-value">checking</div></div></div>
        <div class="stat-card" style="display:flex;align-items:center;gap:16px;padding:14px 18px;min-height:78px;"><div class="stat-icon servers" style="width:56px;
min-width:56px;
font-size:40px;
line-height:1;
text-align:center;
display:flex;
align-items:center;
justify-content:center;">🖧</div><div class="stat-text" style="display:flex;flex-direction:column;justify-content:center;gap:4px;"><div class="stat-label">Incus Servers</div><div id="remoteSummary" class="stat-value">checking</div></div></div>
        <div class="stat-card" style="display:flex;align-items:center;gap:16px;padding:14px 18px;min-height:78px;"><div class="stat-icon instances" style="width:56px;
min-width:56px;
font-size:40px;
line-height:1;
text-align:center;
display:flex;
align-items:center;
justify-content:center;">📦</div><div class="stat-text" style="display:flex;flex-direction:column;justify-content:center;gap:4px;"><div class="stat-label">Instances</div><div id="containerSummary" class="stat-value">checking</div></div></div>
        <div class="stat-card" style="display:flex;align-items:center;gap:16px;padding:14px 18px;min-height:78px;"><div class="stat-icon catalog" style="width:56px;
min-width:56px;
font-size:40px;
line-height:1;
text-align:center;
display:flex;
align-items:center;
justify-content:center;">🛢️</div><div class="stat-text" style="display:flex;flex-direction:column;justify-content:center;gap:4px;"><div class="stat-label">Backup Catalog</div><div id="backupSummary" class="stat-value">checking</div></div></div>
        <div class="stat-card" style="display:flex;align-items:center;gap:16px;padding:14px 18px;min-height:78px;"><div class="stat-icon active" style="width:56px;
min-width:56px;
font-size:40px;
line-height:1;
text-align:center;
display:flex;
align-items:center;
justify-content:center;">💼</div><div class="stat-text" style="display:flex;flex-direction:column;justify-content:center;gap:4px;"><div class="stat-label">Active Jobs</div><div id="activeJobSummary" class="stat-value">checking</div></div></div>
        <div class="stat-card" style="display:flex;align-items:center;gap:16px;padding:14px 18px;min-height:78px;"><div class="stat-icon failed" style="width:56px;
min-width:56px;
font-size:40px;
line-height:1;
text-align:center;
display:flex;
align-items:center;
justify-content:center;">🛡️</div><div class="stat-text" style="display:flex;flex-direction:column;justify-content:center;gap:4px;"><div class="stat-label">Failed Jobs</div><div id="failedJobSummary" class="stat-value">checking</div></div></div>
      </div>

      <div id="remoteErrors" class="message muted"></div>
      <details id="remoteDetails" class="remote-details">
        <summary>Remote Health Details</summary>
        <div id="remoteStatus" class="small"></div>
      </details>
    </section>

    <section>
      <h2>Containers</h2>
      <div class="row controls">
        <button id="backupAllShownButton">Backup Shown</button>
        <button id="scheduleShownButton" class="secondary" type="button">Schedule Shown</button>
        <button id="backupUnprotectedButton" class="secondary">Backup Unprotected Only</button>
        <button id="quickUnprotected" class="secondary">Only unprotected</button>
        <button id="quickFailed" class="secondary">Only failed</button>
        <button id="quickVMs" class="secondary">VMs only</button>
        <span class="search-wrap"><input id="containerSearch" class="search" placeholder="Search containers, remotes, profiles, schedules..." /><button id="clearContainerSearch" class="clear-search-button hidden" type="button" title="Clear search">×</button></span>
        <select id="remoteFilter"><option value="all">All remotes</option></select>
        <select id="statusFilter"><option value="all">All statuses</option><option value="Running">Running</option><option value="Stopped">Stopped</option></select>
        <select id="protectionFilter"><option value="all">All protection states</option><option value="unprotected">Only unprotected</option><option value="protected">Only protected</option><option value="failedJobs">Failed jobs</option><option value="vms">VMs only</option><option value="containers">Containers only</option></select>
        <span id="summary" class="muted"></span>
      </div>

      <div class="table-wrap">
        <table class="sticky-table">
          <thead>
            <tr>
              <th class="sortable" data-instance-sort="remote">Remote</th>
              <th class="sortable" data-instance-sort="name">Instance</th>
              <th class="sortable" data-instance-sort="status">Status</th>
              <th class="sortable" data-instance-sort="type">Type</th>
              <th class="sortable" data-instance-sort="schedule">Schedule</th>
              <th class="sortable" data-instance-sort="lastBackup">Protection</th>
              <th>Backup Mode</th>
              <th>Export Scope</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="instances"></tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Import Local / Orphaned Backup Files</h2>
      <div class="row">
        <span class="search-wrap"><input id="backupSearch" class="search" placeholder="Search backup files or metadata..." /><button id="clearBackupSearch" class="clear-search-button hidden" type="button" title="Clear search">×</button></span>
        <form id="uploadForm" class="row">
          <input type="file" name="backup" accept=".tar.gz" />
          <select id="uploadRemote"></select>
          <input id="uploadRestoreName" placeholder="restore-as name" />
          <button type="submit" class="secondary">Upload and import</button>
        </form>
        <span class="small">Choose a local .tar.gz, select the Incus server, enter the restore name, then import it directly.</span>
      </div>

      <table class="sticky-table">
        <thead>
          <tr>
            <th class="sortable" data-backup-sort="name">File</th>
            <th class="sortable" data-backup-sort="sizeBytes">Size</th>
            <th class="sortable" data-backup-sort="ageDays">Age</th>
            <th class="sortable" data-backup-sort="source">Source</th>
            <th>Restore To</th>
            <th>Restore As</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="backups"></tbody>
      </table>
    </section>

    <section>
      <h2>Recent Activity</h2>
      <div id="message" class="message muted">No system events.</div>
      <div id="eventFeed" class="event-feed"></div>
    </section>
  </main>

  <div id="bulkScheduleModal" class="modal-backdrop hidden" style="display:none !important;">
    <div class="modal-card bulk-schedule-card">
      <h2 id="bulkScheduleTitle">Schedule Shown</h2>
      <p class="muted" id="bulkScheduleDescription">
        Applies to the instances visible right now. Future filter changes will not change these schedules.
      </p>

      <div class="bulk-schedule-grid">
        <label>
          <span>Frequency</span>
          <select id="bulkScheduleFrequency">
            <option value="off">Off / Disable schedules</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>

        <label data-bulk-schedule-field="daily,weekly,monthly">
          <span>Start time</span>
          <input id="bulkScheduleTime" type="time" value="02:00" />
        </label>

        <label data-bulk-schedule-field="weekly">
          <span>Day of week</span>
          <select id="bulkScheduleDayOfWeek">
            <option value="0">Sun</option>
            <option value="1">Mon</option>
            <option value="2">Tue</option>
            <option value="3">Wed</option>
            <option value="4">Thu</option>
            <option value="5">Fri</option>
            <option value="6">Sat</option>
          </select>
        </label>

        <label data-bulk-schedule-field="monthly">
          <span>Day of month</span>
          <input id="bulkScheduleDayOfMonth" type="number" min="1" max="31" value="1" />
        </label>

        <label data-bulk-schedule-field="daily,weekly,monthly">
          <span>Retention</span>
          <input id="bulkScheduleRetention" type="number" min="1" max="365" value="7" />
        </label>

        <label data-bulk-schedule-field="daily,weekly,monthly">
          <span>Stagger</span>
          <select id="bulkScheduleStagger">
            <option value="0">Do not stagger</option>
            <option value="5" selected>5 minutes apart</option>
            <option value="10">10 minutes apart</option>
            <option value="15">15 minutes apart</option>
          </select>
        </label>
      </div>

      <div class="bulk-schedule-note">
        Backup mode and export scope will use each instance row's current saved setting.
      </div>

      <div class="row" style="justify-content:flex-end;margin-top:14px;">
        <button id="closeBulkScheduleButton" class="secondary" type="button">Cancel</button>
        <button id="applyBulkScheduleButton" type="button">Apply Schedule</button>
      </div>
    </div>
  </div>

  <div id="donateModal" class="modal-backdrop hidden">
    <div class="modal-card">
      <h2>Support ScottiBYTE Incus Backup</h2>
      <p class="muted">Thank you for supporting ongoing development.</p>
      <div class="donate-options">
        <div class="zelle-box">
          <strong>PayPal</strong>
          <span>Send to: <span class="donate-email">vmsman@gmail.com</span></span>
        </div>
        <div class="zelle-box">
          <strong>Zelle</strong>
          <span id="zelleEmail">vmsman@gmail.com</span>
          <button id="copyZelleButton" class="secondary" type="button">Copy Zelle Email</button>
        </div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px;">
        <button id="closeDonateButton" class="secondary" type="button">Close</button>
      </div>
    </div>
  </div>

  <div id="toastBox"></div>
  <script src="/app.js?v=20260614s37"></script>
</body>
</html>`;

const styleCss = String.raw`
:root {
  --bg: #111;
  --panel: #1d1f21;
  --panel2: #151719;
  --header: #151515;
  --text: #eee;
  --muted: #aaa;
  --border: #333;
  --table-head: #2b3138;
  --row-even: #2b3442;
  --row-hover: #354052;
  --input-bg: #111;
  --link: #58a6ff;
}

body.light {
  --bg: #f4f6f8;
  --panel: #f8fafc;
  --panel2: #f1f5f9;
  --header: #ffffff;
  --text: #111827;
  --muted: #334155;
  --border: #94a3b8;
  --table-head: #dbeafe;
  --row-even: #e6edf7;
  --row-hover: #dbeafe;
  --input-bg: #ffffff;
  --link: #0b63ce;
}

body { margin: 0; background: var(--bg); color: var(--text); font-family: Arial, sans-serif; }
header { padding: 18px 24px; border-bottom: 1px solid var(--border); background: var(--header); }
h1 { margin: 0; font-size: 28px; }
.header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.theme-toggle { white-space: nowrap; }
.sub { color: var(--muted); margin-top: 6px; }
main { padding: 20px 24px; display: grid; gap: 18px; }
section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
h2 { margin: 0 0 12px; font-size: 20px; }
.table-wrap { max-height: none; overflow: visible; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
th { background: var(--table-head); }
.sticky-table thead th { position: sticky; top: 0; z-index: 4; background: var(--table-head); }
tbody tr:nth-child(even):not(.backup-detail-row) td { background: var(--row-even); }
tr:hover td { background: var(--row-hover); }
a { color: var(--link); text-decoration: none; }
button { background: #2563eb; color: white; border: none; padding: 7px 11px; border-radius: 5px; cursor: pointer; }
button:hover { filter: brightness(1.1); }
button.danger { background: #b91c1c; }
button.secondary { background: #444; }
button.disabled, button:disabled { background: #4b5563; color: #aaa; cursor: not-allowed; filter: none; }
input, select { background: var(--input-bg); color: var(--text); border: 1px solid #555; padding: 8px; border-radius: 5px; }
input.search { min-width: 280px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.controls { gap: 8px; }
.status-running, .fresh, .job-completed, .remote-ok { color: #22c55e; font-weight: bold; }
.status-stopped, .old, .job-failed, .remote-bad { color: #ef4444; font-weight: bold; }
.aging, .job-running { color: #facc15; font-weight: bold; }
.status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 800;
  border: 1px solid transparent;
}
.status-pill.running {
  background: #0f3b22;
  color: #6ee7a8;
  border-color: #198754;
}
.status-pill.stopped {
  background: #4c1111;
  color: #fca5a5;
  border-color: #dc2626;
}
.status-pill.busy {
  background: #4a3b00;
  color: #fde68a;
  border-color: #ca8a04;
}
.status-pill.unknown {
  background: #374151;
  color: #d1d5db;
  border-color: #6b7280;
}
body.light .status-pill.running {
  background: #dcfce7;
  color: #166534;
  border-color: #22c55e;
}
body.light .status-pill.stopped {
  background: #fee2e2;
  color: #991b1b;
  border-color: #ef4444;
}
body.light .status-pill.busy {
  background: #fef3c7;
  color: #92400e;
  border-color: #f59e0b;
}
body.light .status-pill.unknown {
  background: #e5e7eb;
  color: #374151;
  border-color: #9ca3af;
}
.message { white-space: pre-wrap; color: #facc15; }
.muted { color: var(--muted); }
.small { font-size: 12px; color: #bbb; }
.kind-icon { opacity: 0.9; margin-right: 6px; }
.protection-pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 3px 9px; font-weight: 800; font-size: 12px; }
.protection-today { background: #0f3b22; color: #6ee7a8; border: 1px solid #198754; }
.protection-recent { background: #5f4700; color: #ffd84d; border: 1px solid #c89600; }
.protection-stale { background: #5c2e00; color: #fdba74; border: 1px solid #f97316; }
.protection-none { background: #4c1111; color: #fca5a5; border: 1px solid #dc2626; }
.protection-failed { background: #4c1111; color: #fca5a5; border: 1px solid #dc2626; }
.job-chip { display: inline-block; border-radius: 999px; padding: 3px 8px; background: #3a2f00; color: #facc15; font-weight: 800; }
.job-chip.running { animation: pulse 1.4s infinite; }
.job-chip.completed { background: #0f3b22; color: #6ee7a8; }
.job-chip.failed { background: #4c1111; color: #fca5a5; }
@keyframes pulse { 0% { opacity: 0.55; } 50% { opacity: 1; } 100% { opacity: 0.55; } }
.backup-detail-row td { padding: 0 !important; background: #11161d !important; border-top: none; }
.backup-detail-wrap { padding: 12px 18px; border-left: 3px solid #2d74ff; background: #11161d; }
.backup-detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 10px; }
.backup-detail-title { font-weight: 700; color: #d7e3ff; }
.backup-detail-meta { color: #8fa7c7; font-size: 12px; }
.backup-detail-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.backup-detail-controls input, .backup-detail-controls select { min-width: 180px; }
.backup-detail-controls button { white-space: nowrap; }
.collapse-button { background: #374151; padding: 3px 8px; margin-right: 8px; }
.badge { display: inline-block; background: #374151; color: #ddd; border-radius: 999px; padding: 2px 8px; font-size: 12px; margin-left: 8px; }
.inline-action { margin-left: 8px; }
.icon-button-group { display: flex; gap: 6px; flex-wrap: wrap; }
.status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-top: 12px; }
.stat-card { background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; padding: 10px; }
.stat-label { font-size: 13px; margin-bottom: 4px; font-weight: 800; }
.stat-value {
  font-size: 17px;
  font-weight: 900;
  line-height: 1.2;
}
.remote-details { margin-top: 10px; }
.remote-details summary { cursor: pointer; color: #ddd; font-weight: bold; }
.remote-health-grid { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.remote-card { background: #151719; border: 1px solid #333; border-radius: 8px; padding: 10px; }
.remote-card.offline { border-color: #7f1d1d; }
.remote-summary { display: flex; flex-direction: column; gap: 4px; }
.remote-summary-main { font-size: 14px; font-weight: 700; }
.remote-summary-sub { font-size: 12px; color: #bbb; }
th.sortable { cursor: pointer; user-select: none; }
th.sortable::after { content: ' ↕'; color: #8fa7c7; font-size: 11px; opacity: 0.75; }
th.sortable.sort-asc,
th.sortable.sort-desc {
  color: #58a6ff;
}
th.sortable.sort-asc::after { content: ' ▲'; color: #58a6ff; opacity: 1; font-weight: 900; }
th.sortable.sort-desc::after { content: ' ▼'; color: #58a6ff; opacity: 1; font-weight: 900; }
th.sortable:hover { background: #30363d; color: #ffffff; }
body.light th.sortable.sort-asc,
body.light th.sortable.sort-desc {
  color: #0b63ce;
}
.sticky-table thead th {
  border-top: 1px solid #3b4652;
  border-bottom: 2px solid #58a6ff;
  box-shadow: 0 3px 12px rgba(0,0,0,0.45);
}
.sticky-table thead th {
  border-bottom-width: 3px;
}

body.light .sticky-table thead th {
  background: #cfe3ff;
  border-top: 1px solid #8bbcff;
  border-bottom: 4px solid #0b63ce;
  color: #0f172a;
  box-shadow: 0 4px 14px rgba(37, 99, 235, 0.28);
}

body.light th.sortable::after {
  color: #2563eb;
  opacity: 0.95;
}

body.light th.sortable.sort-asc,
body.light th.sortable.sort-desc {
  color: #003f91;
  background: #bfdbfe;
}


body.light .small,
body.light .muted,
body.light .stat-card .small,
body.light summary,
body.light .sub {
  color: #334155 !important;
}

body.light .stat-card {
  background: #f8fafc;
  border-color: #94a3b8;
  color: #0f172a;
}

body.light .remote-card {
  background: #f8fafc;
  border: 1px solid #94a3b8;
  color: #0f172a;
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.10);
}

body.light .remote-card .remote-ok,
body.light .remote-card .remote-bad {
  font-weight: 800;
}

body.light .remote-card .small,
body.light .remote-card .muted {
  color: #334155 !important;
}

body.light .remote-card strong,
body.light .remote-card b {
  color: #0f172a;
}

body.light #lastRefreshTime {
  color: #475569 !important;
}

body.light .backup-detail-row td {
  background: #f8fafc;
  color: #0f172a;
}

body.light .backup-detail-meta {
  color: #334155;
}

body.light .backup-detail-row td {
  background: #f8fafc !important;
  color: #0f172a !important;
}

body.light .backup-detail-wrap {
  background: #f8fafc !important;
  border-left: 3px solid #0b63ce !important;
}

body.light .backup-detail-title {
  color: #0f172a !important;
}

body.light .backup-detail-title a {
  color: #0b63ce !important;
}

body.light .backup-detail-meta {
  color: #475569 !important;
}

body.light .backup-detail-controls input,
body.light .backup-detail-controls select {
  background: #ffffff !important;
  color: #0f172a !important;
  border: 1px solid #94a3b8 !important;
}

body.light th.sortable.sort-asc::after,
body.light th.sortable.sort-desc::after {
  color: #003f91;
  opacity: 1;
}
.event-feed { margin-top: 8px; display: grid; gap: 4px; }
.event-item { font-size: 12px; color: #bbb; }
.event-item.success { color: #6ee7a8; }
.event-item.error { color: #fca5a5; }
.event-item.info { color: #bbb; }
.event-time { color: #777; margin-right: 8px; }
#toastBox { position: fixed; right: 20px; bottom: 20px; display: grid; gap: 10px; z-index: 9999; }
.toast { background: #1f2937; border: 1px solid #4b5563; color: #fff; border-radius: 8px; padding: 10px 14px; box-shadow: 0 8px 30px rgba(0,0,0,0.35); min-width: 260px; }
.toast.good { border-color: #22c55e; }
.toast.bad { border-color: #ef4444; }
.toast.warn { border-color: #facc15; }
/* FINAL light-mode stat label override */
body.light .status-grid .stat-card .stat-label,
body.light .status-grid .stat-label,
body.light .stat-label {
  color: #1e293b !important;
  font-weight: 900 !important;
  opacity: 1 !important;
}

body.light .status-grid .stat-card .stat-value,
body.light .status-grid .stat-value,
body.light .stat-value {
  color: #020617 !important;
  font-weight: 900 !important;
}

/* Final themed status label/value weight */
body.light .status-grid .stat-label,
body.light .stat-card .stat-label,
body.light .stat-label {
  color: #334155 !important;
  font-weight: 800 !important;
  opacity: 1 !important;
}

body.light .status-grid .stat-value,
body.light .stat-card .stat-value,
body.light .stat-value {
  color: #0f172a !important;
  font-weight: 900 !important;
}

body:not(.light) .status-grid .stat-label,
body:not(.light) .stat-card .stat-label,
body:not(.light) .stat-label {
  color: #cbd5e1 !important;
  font-weight: 800 !important;
  opacity: 1 !important;
}

body:not(.light) .status-grid .stat-value,
body:not(.light) .stat-card .stat-value,
body:not(.light) .stat-value {
  color: #ffffff !important;
  font-weight: 900 !important;
}


.schedule-editor-grid {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 10px;
}
.schedule-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.schedule-field label {
  font-size: 12px;
  color: #9fb5d1;
  font-weight: 700;
}
.schedule-field input,
.schedule-field select {
  min-width: 150px;
}
.schedule-check {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
}
.schedule-check input {
  min-width: auto;
}
.schedule-hidden {
  display: none !important;
}
body.light .schedule-field label {
  color: #334155;
}


.search-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.clear-search-button {
  background: #374151;
  color: #e5e7eb;
  border: 1px solid #4b5563;
  border-radius: 999px;
  width: 28px;
  height: 28px;
  padding: 0;
  font-weight: 900;
  line-height: 1;
}
.clear-search-button:hover {
  background: #4b5563;
}
.clear-search-button.hidden {
  display: none;
}
body.light .clear-search-button {
  background: #e2e8f0;
  color: #0f172a;
  border-color: #94a3b8;
}
body.light .clear-search-button:hover {
  background: #cbd5e1;
}


/* Put search clear X inside the search field */
.search-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.search-wrap input.search {
  padding-right: 34px;
}

.search-wrap .clear-search-button {
  position: absolute;
  right: 7px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 999px;
  font-size: 15px;
  font-weight: 900;
  line-height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #374151;
  color: #d1d5db;
  border: 1px solid #4b5563;
  z-index: 2;
}

.search-wrap .clear-search-button:hover {
  background: #4b5563;
  color: #ffffff;
}

.search-wrap .clear-search-button.hidden {
  display: none;
}

body.light .search-wrap .clear-search-button {
  background: #e2e8f0;
  color: #334155;
  border-color: #94a3b8;
}

body.light .search-wrap .clear-search-button:hover {
  background: #cbd5e1;
  color: #0f172a;
}


.instance-details-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  align-items: stretch;
  margin-top: 4px;
}

.instance-detail-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(96, 165, 250, 0.28);
  border-radius: 8px;
  padding: 8px 12px;
  min-height: 20px;
  font-size: 15px;
  line-height: 1.35;
}

.instance-detail-label {
  font-weight: 800;
  color: #d7e3ff;
  white-space: nowrap;
}

.instance-detail-value {
  color: #f3f7ff;
  word-break: break-word;
}

body.light .instance-detail-chip {
  background: #eaf3ff;
  border-color: #bfd8ff;
}

body.light .instance-detail-label {
  color: #0f172a;
}

body.light .instance-detail-value {
  color: #1e293b;
}


/* Prevent the main instance table from crushing columns on narrower screens */
.table-wrap {
  overflow-x: auto;
  overflow-y: visible;
  max-width: 100%;
}

.table-wrap table {
  min-width: 1450px;
}

/* Keep operational columns readable */
.sticky-table th,
.sticky-table td {
  white-space: nowrap;
}

.sticky-table th:nth-child(2),
.sticky-table td:nth-child(2) {
  min-width: 210px;
}

.sticky-table th:nth-child(6),
.sticky-table td:nth-child(6) {
  min-width: 150px;
}

.sticky-table th:nth-child(7),
.sticky-table td:nth-child(7),
.sticky-table th:nth-child(8),
.sticky-table td:nth-child(8) {
  min-width: 160px;
}

/* Allow expanded detail rows to use full readable width */
.backup-detail-row td {
  white-space: normal !important;
}

.backup-detail-wrap {
  min-width: 1300px;
}

/* Make the top controls wrap more cleanly */
.controls {
  align-items: center;
}

.search-wrap input.search {
  min-width: 320px;
}


.bulk-schedule-card {
  width: min(760px, 92vw);
}

.bulk-schedule-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.bulk-schedule-grid label {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.bulk-schedule-grid label span {
  font-size: 12px;
  font-weight: 800;
  color: #9fb5d1;
}

.bulk-schedule-grid input,
.bulk-schedule-grid select {
  width: 100%;
  min-width: 0;
}

.bulk-schedule-hidden {
  display: none !important;
}

.bulk-schedule-note {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(96, 165, 250, 0.25);
  border-radius: 8px;
  background: rgba(59, 130, 246, 0.08);
  color: #c7d9f4;
  font-size: 13px;
}

body.light .bulk-schedule-grid label span {
  color: #334155;
}

body.light .bulk-schedule-note {
  background: #eaf3ff;
  border-color: #bfd8ff;
  color: #1e293b;
}


/* Forced inline bulk schedule panel */
.bulk-inline-panel {
  margin: 12px 0 14px;
  padding: 14px;
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-left: 4px solid #58a6ff;
  border-radius: 8px;
  background: rgba(17, 22, 29, 0.92);
}

.bulk-inline-panel.hidden {
  display: none !important;
}

body.light .bulk-inline-panel {
  background: #f8fafc;
  border-color: #bfd8ff;
  border-left-color: #0b63ce;
}


/* Retire old broken bulk modal path */
#bulkScheduleModal {
  display: none !important;
}

`;

const appJs = String.raw`
let REMOTES = [], INSTANCES = [], BACKUPS = [], JOBS = [], SERVER_EVENTS = [];
let SETTINGS = { instancePolicies: {} };
let INSTANCE_UI_STATE = {};
try {
  localStorage.removeItem('incusBackupUiState');
} catch {}

function saveInstanceUiState() {
  // Subsection open/closed state is intentionally session-only.
}

let JOB_TIMER = null, COLLAPSED = {};
let INSTANCE_SORT = { field: 'name', dir: 'asc' }, BACKUP_SORT = { field: 'modified', dir: 'desc' };

function byId(id) { return document.getElementById(id); }

function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  const btn = byId('themeToggle');
  if (btn) btn.textContent = theme === 'light' ? '🌙 Dark' : '☀ Light';
}

function toggleTheme() {
  const current = localStorage.getItem('incusBackupTheme') || 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem('incusBackupTheme', next);
  applyTheme(next);
}


function escapeHtml(value) {
  return String(value)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function escapeAttr(value) { return escapeHtml(value); }
function makeId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '_'); }
function matchesSearch(text, query) { return String(text).toLowerCase().includes(String(query).toLowerCase()); }
function sortValue(value) { return value === undefined || value === null ? '' : String(value).toLowerCase(); }
function compareDirection(result, dir) { return dir === 'asc' ? result : -result; }
function backupSortNewestFirst(a, b) { return new Date(b.modified) - new Date(a.modified); }

function renderEvents() {
  const feed = byId('eventFeed');
  if (!feed) return;

  feed.innerHTML = SERVER_EVENTS.map((e) =>
    '<div class="event-item ' +
    escapeAttr(e.level || 'info') +
    '"><span class="event-time">' +
    escapeHtml(new Date(e.at).toLocaleString()) +
    '</span>' +
    escapeHtml(e.message || '') +
    '</div>'
  ).join('');
}

function setMessage(text, important) {
  const box = byId('message');

  if (!text) {
    box.textContent = SERVER_EVENTS.length ? '' : 'No system events.';
    box.className = 'message muted';
    return;
  }

  box.textContent = text;
  box.className = important ? 'message' : 'message muted';
}

function toast(text, kind) {
  const box = byId('toastBox');
  const div = document.createElement('div');

  div.className = 'toast ' + (kind || '');
  div.textContent = text;
  box.appendChild(div);

  setTimeout(() => div.remove(), 4500);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!data.ok) throw new Error(data.error || 'Unknown error');

  return data;
}

function remoteOptions(selected) {
  return REMOTES.map((r) =>
    '<option value="' +
    escapeAttr(r.name) +
    '"' +
    (r.name === selected ? ' selected' : '') +
    '>' +
    escapeHtml(r.name) +
    '</option>'
  ).join('');
}

function refreshRemoteSelectors() {
  const upload = byId('uploadRemote');

  if (upload) {
    upload.innerHTML = remoteOptions(upload.value || (REMOTES[0] ? REMOTES[0].name : ''));
  }

  const filter = byId('remoteFilter');

  if (filter) {
    const current = filter.value || 'all';
    filter.innerHTML =
      '<option value="all">All remotes</option>' +
      REMOTES.map((r) =>
        '<option value="' +
        escapeAttr(r.name) +
        '"' +
        (r.name === current ? ' selected' : '') +
        '>' +
        escapeHtml(r.name) +
        '</option>'
      ).join('');
  }
}

function getBackupsForInstance(remote, name) {
  return BACKUPS.filter((file) => {
    const m = file.metadata || {};
    return m.sourceRemote === remote && m.sourceInstance === name;
  }).sort(backupSortNewestFirst);
}

function getJobsForInstance(remote, name) {
  return JOBS.filter((job) =>
    (job.sourceRemote === remote && job.sourceInstance === name) ||
    (job.destinationRemote === remote && job.destinationInstance === name)
  );
}

function isBackupMatchedToCurrentContainer(file) {
  const m = file.metadata || {};
  return !!(m.sourceRemote && m.sourceInstance && INSTANCES.some((i) =>
    i.remote === m.sourceRemote && i.name === m.sourceInstance
  ));
}

function containerExists(remote, name) {
  return INSTANCES.some((i) => i.remote === remote && i.name === name);
}

function nextAvailableCloneName(remote, baseName) {
  let c = baseName + '-restored';
  let n = 2;

  while (containerExists(remote, c)) {
    c = baseName + '-restored-' + n;
    n += 1;
  }

  return c;
}

function getOriginalRestoreName(file) {
  const m = file.metadata || {};
  if (m.sourceInstance) return m.sourceInstance;

  return file.name
    .replace(/\\.tar\\.gz$/, '')
    .replace(/^.*--/, '')
    .replace(/--[0-9]{4}-.+$/, '');
}

function getCloneRestoreName(file, remote) {
  return nextAvailableCloneName(
    remote || (REMOTES[0] ? REMOTES[0].name : ''),
    getOriginalRestoreName(file)
  );
}

function backupSource(file) {
  const m = file.metadata || {};
  return m.sourceRemote && m.sourceInstance
    ? m.sourceRemote + ':' + m.sourceInstance
    : (m.uploadedOriginalName || 'manual/unknown');
}


function getInstancePolicy(remote, instance) {
  const key = String(remote || '') + ':' + String(instance || '');
  const policies = SETTINGS && SETTINGS.instancePolicies ? SETTINGS.instancePolicies : {};
  return policies[key] || {};
}

function getPolicyBackupMode(remote, instance) {
  if (String(instance || '').toLowerCase() === 'incusbackup') return 'live';

  const key = String(remote || '') + ':' + String(instance || '');
  const policy = (SETTINGS.instancePolicies || {})[key] || {};
  return ['live', 'stop-restart'].includes(policy.backupMode) ? policy.backupMode : 'live';
}

function getPolicyExportScope(remote, instance) {
  const key = String(remote || '') + ':' + String(instance || '');
  const policy = (SETTINGS.instancePolicies || {})[key] || {};
  return ['instance-only', 'include-snapshots'].includes(policy.exportScope) ? policy.exportScope : 'instance-only';
}

function getPolicySchedule(remote, instance) {
  const key = String(remote || '') + ':' + String(instance || '');
  const policy = (SETTINGS.instancePolicies || {})[key] || {};
  const schedule = policy.schedule || {};
  const rawFrequency = ['off', 'hourly', 'daily', 'weekly', 'monthly'].includes(schedule.frequency) ? schedule.frequency : 'off';
  const enabled = Boolean(schedule.enabled) && rawFrequency !== 'off';
  const frequency = enabled ? rawFrequency : 'off';

  return {
    enabled,
    frequency,
    everyHours: Math.max(1, Math.min(168, Number(schedule.everyHours || 24))),
    time: /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(String(schedule.time || '')) ? String(schedule.time) : '02:00',
    dayOfWeek: Math.max(0, Math.min(6, Number(schedule.dayOfWeek ?? 0))),
    dayOfMonth: Math.max(1, Math.min(31, Number(schedule.dayOfMonth || 1))),
    retentionCount: Math.max(1, Math.min(365, Number(schedule.retentionCount || 7))),
    runMissed: Boolean(schedule.runMissed),
  };
}

function dayName(value) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(value) || 0] || 'Sun';
}

function scheduleSummary(remote, instance) {
  const schedule = getPolicySchedule(remote, instance);

  if (!schedule.enabled || schedule.frequency === 'off') return 'Off';
  if (schedule.frequency === 'hourly') return 'Every ' + schedule.everyHours + 'h';
  if (schedule.frequency === 'daily') return 'Daily ' + schedule.time;
  if (schedule.frequency === 'weekly') return 'Weekly ' + dayName(schedule.dayOfWeek) + ' ' + schedule.time;
  if (schedule.frequency === 'monthly') return 'Monthly day ' + schedule.dayOfMonth + ' ' + schedule.time;

  return 'Off';
}

function scheduleSortValue(item) {
  return scheduleSummary(item.remote, item.name);
}

function getDetailsOpenKey(remote, instance, section) {
  return String(remote || '') + ':' + String(instance || '') + ':' + section;
}

function isSectionOpen(remote, instance, section) {
  return INSTANCE_UI_STATE[getDetailsOpenKey(remote, instance, section)] === true;
}

function setSectionOpen(remote, instance, section, open) {
  INSTANCE_UI_STATE[getDetailsOpenKey(remote, instance, section)] = Boolean(open);
  saveInstanceUiState();
  renderInstances();
}

async function saveInstancePolicy(remote, instance, patch) {
  const data = await api('/api/settings/instance-policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remote, instance, ...patch }),
  });

  SETTINGS = data.settings || SETTINGS;
  toast('Saved policy for ' + remote + ':' + instance, 'good');
}

function instanceIcon(item) {
  return item.type === 'virtual-machine' ? '🖥' : '📦';
}

function getProtectionInfo(backups, jobs) {
  if (jobs && jobs.some((j) => j.status === 'failed')) {
    return { text: '⚠ Failed Job', cls: 'protection-pill protection-failed', age: 999998 };
  }

  if (!backups.length) {
    return { text: '🔴 No Backup', cls: 'protection-pill protection-none', age: 999999 };
  }

  const newest = backups[0];

  if (newest.ageDays === 0) {
    return { text: '🟢 Backed Up Today', cls: 'protection-pill protection-today', age: newest.ageDays };
  }

  if (newest.ageDays <= 7) {
    return { text: '🟡 ' + newest.ageDays + 'd Old', cls: 'protection-pill protection-recent', age: newest.ageDays };
  }

  return { text: '🟠 Stale · ' + newest.ageDays + 'd', cls: 'protection-pill protection-stale', age: newest.ageDays };
}

function setInstanceSort(field) {
  if (INSTANCE_SORT.field === field) {
    INSTANCE_SORT.dir = INSTANCE_SORT.dir === 'asc' ? 'desc' : 'asc';
  } else {
    INSTANCE_SORT = { field, dir: 'asc' };
  }

  renderInstances();
}

function setBackupSort(field) {
  if (BACKUP_SORT.field === field) {
    BACKUP_SORT.dir = BACKUP_SORT.dir === 'asc' ? 'desc' : 'asc';
  } else {
    BACKUP_SORT = {
      field,
      dir: field === 'ageDays' || field === 'sizeBytes' ? 'desc' : 'asc',
    };
  }

  renderBackups();
}

function compareInstances(a, b) {
  let av;
  let bv;

  if (INSTANCE_SORT.field === 'profiles') {
    av = (a.profiles || []).join(', ');
    bv = (b.profiles || []).join(', ');
  } else if (INSTANCE_SORT.field === 'schedule') {
    av = scheduleSortValue(a);
    bv = scheduleSortValue(b);
  } else if (INSTANCE_SORT.field === 'lastBackup') {
    av = getProtectionInfo(getBackupsForInstance(a.remote, a.name), getJobsForInstance(a.remote, a.name)).age;
    bv = getProtectionInfo(getBackupsForInstance(b.remote, b.name), getJobsForInstance(b.remote, b.name)).age;
    return compareDirection(av - bv, INSTANCE_SORT.dir);
  } else {
    av = a[INSTANCE_SORT.field];
    bv = b[INSTANCE_SORT.field];
  }

  return compareDirection(sortValue(av).localeCompare(sortValue(bv)), INSTANCE_SORT.dir);
}

function compareBackups(a, b) {
  let av;
  let bv;

  if (BACKUP_SORT.field === 'source') {
    av = backupSource(a);
    bv = backupSource(b);
  } else if (BACKUP_SORT.field === 'ageDays' || BACKUP_SORT.field === 'sizeBytes') {
    av = Number(a[BACKUP_SORT.field] || 0);
    bv = Number(b[BACKUP_SORT.field] || 0);
    return compareDirection(av - bv, BACKUP_SORT.dir);
  } else if (BACKUP_SORT.field === 'modified') {
    av = new Date(a.modified).getTime();
    bv = new Date(b.modified).getTime();
    return compareDirection(av - bv, BACKUP_SORT.dir);
  } else {
    av = a[BACKUP_SORT.field];
    bv = b[BACKUP_SORT.field];
  }

  return compareDirection(sortValue(av).localeCompare(sortValue(bv)), BACKUP_SORT.dir);
}

function renderRemoteHealth() {
  byId('remoteStatus').innerHTML =
    '<div class="remote-health-grid">' +
    REMOTES.map((r) => {
      const online = r.reachable;
      const cls = online ? 'remote-ok' : 'remote-bad';

      return '<div class="remote-card' + (online ? '' : ' offline') + '">' +
        '<div class="remote-summary">' +
        '<div class="remote-summary-main ' + cls + '">' +
        escapeHtml(r.name) +
        ' · ' +
        (online ? 'Online' : 'Offline') +
        '</div>' +
        '<div class="remote-summary-sub">Incus ' +
        escapeHtml(r.serverVersion || (online ? 'version unknown' : 'offline')) +
        '</div>' +
        '<div class="remote-summary-sub">' +
        (r.containerCount || 0) +
        ' containers · ' +
        (r.vmCount || 0) +
        ' VMs</div>' +
        '<div class="remote-summary-sub">' +
        (r.runningCount || 0) +
        ' running · ' +
        (r.stoppedCount || 0) +
        ' stopped</div>' +
        '</div></div>';
    }).join('') +
    '</div>';
}

function toggleBackups(remote, name) {
  const key = remote + ':' + name;
  COLLAPSED[key] = COLLAPSED[key] === false ? true : false;
  renderInstances();
}

async function loadHealth() {
  try {
    const data = await api('/api/health');
    REMOTES = data.remotes || [];
    const t = data.totals || {};

    byId('health').textContent = '';
    const versionPill = byId('versionPill');
    if (versionPill) {
      versionPill.textContent = data.version && data.version !== 'development' ? 'GitHub v' + data.version : 'GitHub Dev Build';
      versionPill.title = data.version && data.version !== 'development'
        ? 'View GitHub releases. Running version v' + data.version
        : 'View GitHub releases. Development build. Set APP_VERSION in Docker to show a release version.';
    }

    byId('clientStatus').textContent = 'Client OK';
    byId('remoteSummary').textContent =
      (t.reachableRemotes || 0) + ' reachable / ' + (t.remotes || 0) + ' configured';
    byId('containerSummary').textContent =
      (t.instances || 0) +
      ' total / ' +
      (t.containers || 0) +
      ' containers / ' +
      (t.virtualMachines || 0) +
      ' VMs';
    byId('backupSummary').textContent = (t.backups || BACKUPS.length) + ' cataloged backups';
    byId('activeJobSummary').textContent = String(t.activeJobs || 0);
    byId('failedJobSummary').textContent = String(t.failedJobs || 0);

    renderRemoteHealth();
    refreshRemoteSelectors();
  } catch (err) {
    byId('health').textContent = 'Incus client problem: ' + err.message;
    byId('clientStatus').textContent = 'Client error';
    setMessage('Health check failed: ' + err.message, true);
  }
}

async function loadInstances() {
  const data = await api('/api/instances');

  REMOTES = data.remotes || REMOTES;
  INSTANCES = data.instances || [];
  SETTINGS = data.settings || SETTINGS;

  const errors = data.errors || [];
  byId('remoteErrors').textContent = errors.length
    ? errors.length + ' remote(s) unavailable or skipped. See Remote Health Details.'
    : '';

  refreshRemoteSelectors();
  renderScheduledSummary();
  renderInstances();
}

function getFilteredInstances() {
  const query = byId('containerSearch').value || '';
  const rf = byId('remoteFilter').value || 'all';
  const sf = byId('statusFilter').value || 'all';
  const pf = byId('protectionFilter').value || 'all';

  return INSTANCES.filter((item) => {
    const backups = getBackupsForInstance(item.remote, item.name);
    const jobs = getJobsForInstance(item.remote, item.name);

    const protection = getProtectionInfo(backups, jobs);
    const schedule = getPolicySchedule(item.remote, item.name);

    const haystack = [
      item.remote,
      item.name,
      item.status,
      item.type,
      (item.profiles || []).join(' '),
      scheduleSummary(item.remote, item.name),
      protection.text,
      backups.map((b) => b.name).join(' '),
      jobs.map((j) => j.status + ' ' + j.title + ' ' + j.message).join(' '),
    ].join(' ');

    if (rf !== 'all' && item.remote !== rf) return false;
    if (sf !== 'all' && item.status !== sf) return false;
    if (pf === 'unprotected' && backups.length > 0) return false;
    if (pf === 'protected' && backups.length === 0) return false;
    if (pf === 'failedJobs' && !jobs.some((j) => j.status === 'failed')) return false;
    if (pf === 'scheduled' && !schedule.enabled) return false;
    if (pf === 'vms' && item.type !== 'virtual-machine') return false;
    if (pf === 'containers' && item.type !== 'container') return false;

    return matchesSearch(haystack, query);
  }).sort(compareInstances);
}

function updateSortHeaders() {
  document.querySelectorAll('[data-instance-sort]').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.instanceSort === INSTANCE_SORT.field) {
      th.classList.add(INSTANCE_SORT.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });

  document.querySelectorAll('[data-backup-sort]').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.backupSort === BACKUP_SORT.field) {
      th.classList.add(BACKUP_SORT.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function statusPillClass(status) {
  const lower = String(status || '').toLowerCase();
  if (lower === 'running') return 'status-pill running';
  if (lower === 'stopped') return 'status-pill stopped';
  if (['exporting', 'stopping', 'restarting', 'importing', 'deleting', 'queued', 'stopped'].includes(lower) && lower !== 'stopped') return 'status-pill busy';
  if (lower.includes('export') || lower.includes('restart') || lower.includes('stop') || lower.includes('import') || lower.includes('delete')) return 'status-pill busy';
  return 'status-pill unknown';
}

function displayStatusText(status) {
  const text = String(status || 'Unknown');
  if (text === 'stop-restart') return 'Stop + Restart';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function countScheduledInstances() {
  return INSTANCES.filter((item) => getPolicySchedule(item.remote, item.name).enabled).length;
}

function countScheduledShown() {
  return getFilteredInstances().filter((item) => getPolicySchedule(item.remote, item.name).enabled).length;
}

function ensureScheduledStatusCard() {
  if (byId('scheduledJobSummary')) return;

  const grid = document.querySelector('.status-grid');
  if (!grid) return;

  const card = document.createElement('div');
  card.className = 'stat-card';
  card.style.cssText = 'display:flex;align-items:center;gap:16px;padding:14px 18px;min-height:78px;';
  card.innerHTML =
    '<div class="stat-icon scheduled" style="width:56px;min-width:56px;font-size:40px;line-height:1;text-align:center;display:flex;align-items:center;justify-content:center;">📅</div>' +
    '<div class="stat-text" style="display:flex;flex-direction:column;justify-content:center;gap:4px;">' +
    '<div class="stat-label">Scheduled Backups</div>' +
    '<div id="scheduledJobSummary" class="stat-value">0</div>' +
    '</div>';

  const activeCard = byId('activeJobSummary') ? byId('activeJobSummary').closest('.stat-card') : null;
  if (activeCard && activeCard.parentNode === grid) {
    grid.insertBefore(card, activeCard);
  } else {
    grid.appendChild(card);
  }
}

function renderScheduledSummary() {
  ensureScheduledStatusCard();

  const box = byId('scheduledJobSummary');
  if (!box) return;

  const scheduled = countScheduledInstances();
  box.textContent = String(scheduled);
  box.title = scheduled + ' instance(s) have enabled backup schedules.';
}

function ensureScheduledControls() {
  const protectionFilter = byId('protectionFilter');

  if (protectionFilter && !Array.from(protectionFilter.options).some((option) => option.value === 'scheduled')) {
    const option = document.createElement('option');
    option.value = 'scheduled';
    option.textContent = 'Only scheduled';
    protectionFilter.appendChild(option);
  }

  const quickVMs = byId('quickVMs');

  if (quickVMs && !byId('quickScheduled')) {
    const button = document.createElement('button');
    button.id = 'quickScheduled';
    button.className = 'secondary';
    button.type = 'button';
    button.textContent = 'Only scheduled';
    button.addEventListener('click', () => {
      byId('protectionFilter').value = 'scheduled';
      renderInstances();
    });
    quickVMs.insertAdjacentElement('afterend', button);
  }

  const scheduleShownButton = byId('scheduleShownButton') || byId('backupAllShownButton');

  if (scheduleShownButton && !byId('unscheduleShownButton')) {
    const button = document.createElement('button');
    button.id = 'unscheduleShownButton';
    button.className = 'secondary';
    button.type = 'button';
    button.textContent = 'Unschedule Shown';
    button.addEventListener('click', unscheduleShown);
    scheduleShownButton.insertAdjacentElement('afterend', button);
  }
}

async function unscheduleShown() {
  const protectionFilter = byId('protectionFilter');

  if (protectionFilter && protectionFilter.value !== 'scheduled') {
    protectionFilter.value = 'scheduled';
    renderInstances();
    toast('Showing scheduled backups', 'good');
    return;
  }

  const targets = getFilteredInstances().filter((item) => getPolicySchedule(item.remote, item.name).enabled);

  if (!targets.length) {
    toast('No scheduled instances are visible', 'warn');
    return;
  }

  let ok = 0;
  let failed = 0;

  for (const item of targets) {
    try {
      await api('/api/settings/instance-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote: item.remote,
          instance: item.name,
          backupMode: getPolicyBackupMode(item.remote, item.name),
          exportScope: getPolicyExportScope(item.remote, item.name),
          schedule: {
            ...getPolicySchedule(item.remote, item.name),
            enabled: false,
            frequency: 'off',
          },
        }),
      });
      ok += 1;
    } catch (err) {
      console.error(err);
      failed += 1;
    }
  }

  toast('Disabled schedules for ' + ok + ' instance(s)' + (failed ? ' · ' + failed + ' failed' : ''), failed ? 'warn' : 'good');

  await loadInstances();

  if (countScheduledInstances() === 0) {
    const protectionFilter = byId('protectionFilter');
    if (protectionFilter) protectionFilter.value = 'all';
    renderInstances();
  }
}

function renderInstances() {
  ensureScheduledControls();
  renderScheduledSummary();
  updateSortHeaders();
  const tbody = byId('instances');
  tbody.innerHTML = '';

  const filtered = getFilteredInstances();

  byId('summary').textContent =
    filtered.length +
    ' shown / ' +
    INSTANCES.length +
    ' instances across ' +
    REMOTES.length +
    ' remotes';

  const backupAllButton = byId('backupAllShownButton');
  if (backupAllButton) {
    backupAllButton.textContent = 'Backup ' + filtered.length + ' Shown';
    backupAllButton.disabled = filtered.length === 0;
  }

  const unscheduleShownButton = byId('unscheduleShownButton');
  if (unscheduleShownButton) {
    const scheduledTotal = countScheduledInstances();
    const scheduledShown = countScheduledShown();
    const protectionFilter = byId('protectionFilter');
    const showingScheduled = protectionFilter && protectionFilter.value === 'scheduled';

    const allShownAreScheduled = filtered.length > 0 && scheduledShown === filtered.length;

    if (showingScheduled || allShownAreScheduled) {
      unscheduleShownButton.textContent = 'Unschedule ' + scheduledShown + ' Shown';
      unscheduleShownButton.disabled = scheduledShown === 0;
      unscheduleShownButton.className = scheduledShown > 0 ? 'danger' : 'secondary disabled';
    } else {
      unscheduleShownButton.textContent = 'Show scheduled' + (scheduledTotal ? ' (' + scheduledTotal + ')' : '');
      unscheduleShownButton.disabled = scheduledTotal === 0;
      unscheduleShownButton.className = scheduledTotal > 0 ? 'secondary' : 'secondary disabled';
    }
  }

  const scheduleShownButton = byId('scheduleShownButton');
  if (scheduleShownButton) {
    scheduleShownButton.textContent = 'Schedule ' + filtered.length + ' Shown';
    scheduleShownButton.disabled = filtered.length === 0;
  }

  if (typeof sbSelfProtectApply === 'function') setTimeout(sbSelfProtectApply, 0);

  if (typeof enforceSelfBackupUiProtection === 'function') {
    try {
      enforceSelfBackupUiProtection();
    } catch (err) {
      console.error(err);
    }
  }

  for (const item of filtered) {
    const backups = getBackupsForInstance(item.remote, item.name);
    const jobs = getJobsForInstance(item.remote, item.name);
    const activeJob = jobs.find((j) => j.status === 'running');
    const displayStatus = activeJob && activeJob.phase ? activeJob.phase : item.status;
    const statusClass =
      displayStatus === 'Running'
        ? 'status-running'
        : displayStatus === 'Stopped'
          ? 'status-stopped'
          : 'aging';

    const key = item.remote + ':' + item.name;
    const isCollapsed = COLLAPSED[key] !== false;
    const protection = getProtectionInfo(backups, jobs);
    const tr = document.createElement('tr');

    let nameCell =
      '<span class="kind-icon">' +
      instanceIcon(item) +
      '</span>' +
      escapeHtml(item.name);

    const totalChildren = backups.length + jobs.length;

    if (true) {
      const symbol = isCollapsed ? '+' : '−';
      nameCell =
        '<button class="collapse-button" data-toggle-remote="' +
        escapeAttr(item.remote) +
        '" data-toggle-instance="' +
        escapeAttr(item.name) +
        '">' +
        symbol +
        '</button>' +
        nameCell +
        ' <span class="badge">' +
        backups.length +
        ' backups' +
        (jobs.length ? ', ' + jobs.length + ' jobs' : '') +
        '</span>';
    }

    const safeId = makeId(item.remote + '-' + item.name);
    const modeId = 'mode-' + safeId;
    const scopeId = 'scope-' + safeId;
    const uiKey = item.remote + ':' + item.name;
    const isSelfBackupApp = String(item.name || '').toLowerCase() === 'incusbackup';
    const selectedMode = getPolicyBackupMode(item.remote, item.name);
    const selectedScope = getPolicyExportScope(item.remote, item.name);

    tr.innerHTML =
      '<td>' +
      escapeHtml(item.remote) +
      '</td><td>' +
      nameCell +
      '</td><td><span class="' +
      escapeAttr(statusPillClass(displayStatus)) +
      '">' +
      escapeHtml(displayStatusText(displayStatus)) +
      '</span></td><td>' +
      escapeHtml(item.type || '') +
      '</td><td><span class="schedule-summary">' +
      escapeHtml(scheduleSummary(item.remote, item.name)) +
      '</span> <button class="secondary inline-action" data-open-schedule-remote="' +
      escapeAttr(item.remote) +
      '" data-open-schedule-instance="' +
      escapeAttr(item.name) +
      '" type="button">Edit</button>' +
      '</td><td><span class="' +
      escapeAttr(protection.cls) +
      '">' +
      escapeHtml(protection.text) +
      '</span></td><td><select id="' +
      modeId +
      '" data-ui-key="' +
      escapeAttr(uiKey) +
      '"><option value="live"' +
      (selectedMode === 'live' ? ' selected' : '') +
      '>Live</option><option value="stop-restart"' +
      (selectedMode === 'stop-restart' ? ' selected' : '') +
      '>Stop + Restart</option></select></td><td><select id="' +
      scopeId +
      '"><option value="instance-only"' +
      (selectedScope === 'instance-only' ? ' selected' : '') +
      '>Instance only</option><option value="include-snapshots"' +
      (selectedScope === 'include-snapshots' ? ' selected' : '') +
      '>Include snapshots</option></select></td><td></td>';

    const toggleButton = tr.querySelector('[data-toggle-remote]');

    if (toggleButton) {
      toggleButton.addEventListener('click', () =>
        toggleBackups(toggleButton.dataset.toggleRemote, toggleButton.dataset.toggleInstance)
      );
    }

    const scheduleButton = tr.querySelector('[data-open-schedule-remote]');
    if (scheduleButton) {
      scheduleButton.addEventListener('click', () => {
        const openKey = scheduleButton.dataset.openScheduleRemote + ':' + scheduleButton.dataset.openScheduleInstance;
        COLLAPSED[openKey] = false;
        setSectionOpen(scheduleButton.dataset.openScheduleRemote, scheduleButton.dataset.openScheduleInstance, 'schedule', true);
      });
    }

    const exportButton = document.createElement('button');
    exportButton.textContent = '⬇ Backup';
    exportButton.addEventListener('click', () =>
      exportBackup(item.remote, item.name, byId(modeId).value, byId(scopeId).value)
    );

    tr.children[8].appendChild(exportButton);
    tbody.appendChild(tr);

    const modeSelect = byId(modeId);
    if (modeSelect) {
      modeSelect.value = isSelfBackupApp ? 'live' : selectedMode;

      if (isSelfBackupApp) {
        modeSelect.value = 'live';
        modeSelect.disabled = true;
        modeSelect.title = 'Self-protected: IncusBackup must use Live mode so it cannot stop the backup application.';

        Array.from(modeSelect.options).forEach((option) => {
          if (option.value === 'live') option.textContent = 'Live - self protected';
          if (option.value === 'stop-restart') option.disabled = true;
        });

        const policy = getInstancePolicy(item.remote, item.name);
        if (policy.backupMode === 'stop-restart') {
          saveInstancePolicy(item.remote, item.name, { backupMode: 'live' }).catch((err) => console.error(err));
        }
      } else {
        modeSelect.addEventListener('change', async () => {
          try {
            await saveInstancePolicy(item.remote, item.name, { backupMode: modeSelect.value });
          } catch (err) {
            setMessage('Could not save backup mode:\n' + err.message, true);
            toast('Could not save backup mode', 'bad');
          }
        });
      }
    }

    const scopeSelect = byId(scopeId);
    if (scopeSelect) {
      scopeSelect.value = selectedScope;
      scopeSelect.addEventListener('change', async () => {
        try {
          await saveInstancePolicy(item.remote, item.name, { exportScope: scopeSelect.value });
        } catch (err) {
          setMessage('Could not save export scope:\n' + err.message, true);
          toast('Could not save export scope', 'bad');
        }
      });
    }

    if (isCollapsed) continue;

    renderScheduleDetailRow(tbody, item);
    renderInstanceDetailsRow(tbody, item);

    const backupFileNames = new Set(backups.map((file) => file.name));
    const relatedRestoreJobs = JOBS.filter((job) =>
      job.sourceFile && backupFileNames.has(job.sourceFile) &&
      !jobs.some((existingJob) => existingJob.id === job.id)
    );

    for (const job of jobs) renderJobDetailRow(tbody, job);
    for (const job of relatedRestoreJobs) renderJobDetailRow(tbody, job);
    for (const file of backups) renderBackupDetailRow(tbody, item, file, backups.length);
  }
}

async function saveSchedulePolicy(remote, instance, schedulePatch) {
  const data = await api('/api/settings/instance-policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      remote,
      instance,
      backupMode: getPolicyBackupMode(remote, instance),
      exportScope: getPolicyExportScope(remote, instance),
      schedule: schedulePatch,
    }),
  });

  SETTINGS = data.settings || SETTINGS;
  toast('Saved schedule for ' + remote + ':' + instance, 'good');
  renderInstances();
}

function updateScheduleFieldVisibility(container) {
  const freq = container.querySelector('[data-schedule-frequency]');
  if (!freq) return;

  const value = freq.value;
  container.querySelectorAll('[data-schedule-field]').forEach((field) => {
    const appliesTo = String(field.dataset.scheduleField || '').split(',');
    field.classList.toggle('schedule-hidden', !appliesTo.includes(value));
  });
}

function renderScheduleDetailRow(tbody, item) {
  const open = isSectionOpen(item.remote, item.name, 'schedule');
  const row = document.createElement('tr');
  row.className = 'backup-detail-row';

  const cell = document.createElement('td');
  cell.colSpan = 9;

  const schedule = getPolicySchedule(item.remote, item.name);
  const safeId = makeId(item.remote + '-' + item.name);
  const enabledId = 'schedule-enabled-' + safeId;
  const freqId = 'schedule-frequency-' + safeId;
  const hoursId = 'schedule-hours-' + safeId;
  const timeId = 'schedule-time-' + safeId;
  const dowId = 'schedule-dow-' + safeId;
  const domId = 'schedule-dom-' + safeId;
  const retentionId = 'schedule-retention-' + safeId;
  const missedId = 'schedule-missed-' + safeId;

  cell.innerHTML =
    '<div class="backup-detail-wrap">' +
    '<div class="backup-detail-header">' +
    '<div class="backup-detail-title"><button class="collapse-button" type="button" data-section-toggle="schedule">' +
    (open ? '−' : '+') +
    '</button>Schedule: ' +
    escapeHtml(scheduleSummary(item.remote, item.name)) +
    '</div>' +
    '<div class="backup-detail-meta">Stored in backups/settings.json · scheduler engine active</div>' +
    '</div>' +
    (open
      ? '<div class="schedule-editor-grid">' +



        '<div class="schedule-field">' +
        '<label for="' + freqId + '">Frequency</label>' +
        '<select id="' + freqId + '" data-schedule-frequency="1">' +
        '<option value="off"' + (schedule.frequency === 'off' ? ' selected' : '') + '>Off</option>' +
        '<option value="hourly"' + (schedule.frequency === 'hourly' ? ' selected' : '') + '>Every N hours</option>' +
        '<option value="daily"' + (schedule.frequency === 'daily' ? ' selected' : '') + '>Daily</option>' +
        '<option value="weekly"' + (schedule.frequency === 'weekly' ? ' selected' : '') + '>Weekly</option>' +
        '<option value="monthly"' + (schedule.frequency === 'monthly' ? ' selected' : '') + '>Monthly</option>' +
        '</select>' +
        '</div>' +

        '<div class="schedule-field" data-schedule-field="hourly">' +
        '<label for="' + hoursId + '">Every how many hours?</label>' +
        '<input id="' + hoursId + '" type="number" min="1" max="168" value="' + escapeAttr(schedule.everyHours) + '" />' +
        '</div>' +

        '<div class="schedule-field" data-schedule-field="daily,weekly,monthly">' +
        '<label for="' + timeId + '">Start time</label>' +
        '<input id="' + timeId + '" type="time" value="' + escapeAttr(schedule.time) + '" />' +
        '</div>' +

        '<div class="schedule-field" data-schedule-field="weekly">' +
        '<label for="' + dowId + '">Day of week</label>' +
        '<select id="' + dowId + '">' +
        [0,1,2,3,4,5,6].map((d) => '<option value="' + d + '"' + (schedule.dayOfWeek === d ? ' selected' : '') + '>' + dayName(d) + '</option>').join('') +
        '</select>' +
        '</div>' +

        '<div class="schedule-field" data-schedule-field="monthly">' +
        '<label for="' + domId + '">Day of month</label>' +
        '<input id="' + domId + '" type="number" min="1" max="31" value="' + escapeAttr(schedule.dayOfMonth) + '" />' +
        '</div>' +

        '<div class="schedule-field" data-schedule-field="hourly,daily,weekly,monthly">' +
        '<label for="' + retentionId + '">Retention</label>' +
        '<div class="schedule-check">Keep <input id="' + retentionId + '" type="number" min="1" max="365" value="' + escapeAttr(schedule.retentionCount) + '" style="width:72px;min-width:72px;" /> backups</div>' +
        '</div>' +

        '<div class="schedule-check" data-schedule-field="hourly,daily,weekly,monthly">' +
        '<input id="' + missedId + '" type="checkbox"' + (schedule.runMissed ? ' checked' : '') + ' />' +
        '<label for="' + missedId + '" class="small">Run missed backup on startup</label>' +
        '</div>' +

        '<button type="button" data-save-schedule="1">Save Schedule</button>' +
        (schedule.enabled ? '<button type="button" class="danger" data-disable-schedule="1">Disable Schedule</button>' : '') +
        '<button type="button" data-run-now="1">Run Now</button>' +
        '</div>'
      : '') +
    '</div>';

  row.appendChild(cell);
  tbody.appendChild(row);

  const toggle = cell.querySelector('[data-section-toggle="schedule"]');
  if (toggle) {
    toggle.addEventListener('click', () => setSectionOpen(item.remote, item.name, 'schedule', !open));
  }

  const freqSelect = cell.querySelector('[data-schedule-frequency]');
  if (freqSelect) {
    updateScheduleFieldVisibility(cell);
    freqSelect.addEventListener('change', () => updateScheduleFieldVisibility(cell));
  }

  const saveButton = cell.querySelector('[data-save-schedule]');
  if (saveButton) {
    saveButton.addEventListener('click', () => {
      const frequency = byId(freqId).value;
      saveSchedulePolicy(item.remote, item.name, {
        enabled: frequency !== 'off',
        frequency,
        everyHours: Number(byId(hoursId).value || 24),
        time: byId(timeId).value || '02:00',
        dayOfWeek: Number(byId(dowId).value || 0),
        dayOfMonth: Number(byId(domId).value || 1),
        retentionCount: Number(byId(retentionId).value || 7),
        runMissed: byId(missedId).checked,
      });
    });
  }

  const disableButton = cell.querySelector('[data-disable-schedule]');
  if (disableButton) {
    disableButton.addEventListener('click', () => {
      saveSchedulePolicy(item.remote, item.name, {
        ...getPolicySchedule(item.remote, item.name),
        enabled: false,
        frequency: 'off',
      });
    });
  }

  const runNowButton = cell.querySelector('[data-run-now]');
  if (runNowButton) {
    runNowButton.addEventListener('click', () =>
      exportBackup(item.remote, item.name, getPolicyBackupMode(item.remote, item.name), getPolicyExportScope(item.remote, item.name))
    );
  }
}


function renderInstanceDetailsRow(tbody, item) {
  const open = isSectionOpen(item.remote, item.name, 'details');
  const row = document.createElement('tr');
  row.className = 'backup-detail-row';

  const cell = document.createElement('td');
  cell.colSpan = 9;

  cell.innerHTML =
    '<div class="backup-detail-wrap">' +
    '<div class="backup-detail-header">' +
    '<div class="backup-detail-title"><button class="collapse-button" type="button" data-section-toggle="details">' +
    (open ? '−' : '+') +
    '</button>Instance Details</div>' +
    '<div class="backup-detail-meta">Profiles and restore-relevant metadata</div>' +
    '</div>' +
    (open
      ? '<div class="instance-details-grid">' +
        '<div class="instance-detail-chip"><span class="instance-detail-label">Profiles:</span><span class="instance-detail-value">' + escapeHtml((item.profiles || []).join(', ') || 'none') + '</span></div>' +
        '<div class="instance-detail-chip"><span class="instance-detail-label">Remote:</span><span class="instance-detail-value">' + escapeHtml(item.remote || '') + '</span></div>' +
        '<div class="instance-detail-chip"><span class="instance-detail-label">Type:</span><span class="instance-detail-value">' + escapeHtml(item.type || '') + '</span></div>' +
        '<div class="instance-detail-chip"><span class="instance-detail-label">Status:</span><span class="instance-detail-value">' + escapeHtml(item.status || '') + '</span></div>' +
        '<div class="instance-detail-chip"><span class="instance-detail-label">Project:</span><span class="instance-detail-value">' + escapeHtml(item.project || 'default') + '</span></div>' +
        '<div class="instance-detail-chip"><span class="instance-detail-label">Architecture:</span><span class="instance-detail-value">' + escapeHtml(item.architecture || '') + '</span></div>' +
        '<div class="instance-detail-chip"><span class="instance-detail-label">Location:</span><span class="instance-detail-value">' + escapeHtml(item.location || 'none') + '</span></div>' +
        '</div>'
      : '') +
    '</div>';

  row.appendChild(cell);
  tbody.appendChild(row);

  const toggle = cell.querySelector('[data-section-toggle="details"]');
  if (toggle) {
    toggle.addEventListener('click', () => setSectionOpen(item.remote, item.name, 'details', !open));
  }
}

function displayBackupMode(value) {
  return value === 'stop-restart' ? 'Stop + Restart' : 'Live';
}

function displayExportScope(value) {
  return value === 'include-snapshots' ? 'Include Snapshots' : 'Instance Only';
}

function renderJobDetailRow(tbody, job) {
  const row = document.createElement('tr');
  row.className = 'backup-detail-row';

  const cell = document.createElement('td');
  cell.colSpan = 9;

  const chipClass =
    job.status === 'running'
      ? 'job-chip running'
      : job.status === 'completed'
        ? 'job-chip completed'
        : job.status === 'failed'
          ? 'job-chip failed'
          : 'job-chip';

  cell.innerHTML =
    '<div class="backup-detail-wrap">' +
    '<div class="backup-detail-header">' +
    '<div class="backup-detail-title">↳ Job: <span class="' +
    chipClass +
    '">' +
    escapeHtml(job.status) +
    '</span> ' +
    escapeHtml(job.title || '') +
    '</div>' +
    '<div class="backup-detail-meta">' +
    escapeHtml(new Date(job.updatedAt).toLocaleString()) +
    '</div></div>' +
    '<div class="backup-detail-meta">' +
    escapeHtml(job.error || job.message || '') +
    '</div>' +
    '<div class="backup-detail-meta">' +
    (job.status === 'running' && job.type === 'export'
      ? escapeHtml('Elapsed: ' + (job.elapsedHuman || '00:00:00') + (job.backupMode ? ' · Mode: ' + displayBackupMode(job.backupMode) : '') + (job.exportScope ? ' · Scope: ' + displayExportScope(job.exportScope) : ''))
      : '') +
    '</div></div>';

  row.appendChild(cell);
  tbody.appendChild(row);
}

function renderBackupDetailRow(tbody, item, file, retainedCount) {
  const row = document.createElement('tr');
  row.className = 'backup-detail-row';

  const cell = document.createElement('td');
  cell.colSpan = 9;

  const baseId = makeId(file.name);
  const remoteId = 'inline-remote-' + baseId;
  const inputId = 'inline-restore-' + baseId;
  const originalName = getOriginalRestoreName(file);
  const cloneName = getCloneRestoreName(file, item.remote);

  cell.innerHTML =
    '<div class="backup-detail-wrap">' +
    '<div class="backup-detail-header">' +
    '<div class="backup-detail-title">↳ Backup: <a href="' +
    file.url +
    '">' +
    escapeHtml(file.name) +
    '</a></div>' +
    '<div class="backup-detail-meta">' +
    escapeHtml(file.size) +
    ' · ' +
    escapeHtml(String(file.ageDays)) +
    ' days old · retained: ' +
    retainedCount +
    '</div></div>' +
    '<div class="backup-detail-controls">' +
    '<select id="' +
    remoteId +
    '">' +
    remoteOptions(item.remote) +
    '</select>' +
    '<input id="' +
    inputId +
    '" value="' +
    escapeAttr(cloneName) +
    '" />' +
    '</div></div>';

  const controls = cell.querySelector('.backup-detail-controls');

  const restoreOriginalButton = document.createElement('button');

  if (containerExists(item.remote, originalName)) {
    restoreOriginalButton.textContent = 'Replace Existing';
    restoreOriginalButton.className = 'danger';
    restoreOriginalButton.title =
      'Destructive restore: stops and deletes the existing instance, then restores this backup using the original name.';
    restoreOriginalButton.addEventListener('click', () => {
      byId(inputId).value = originalName;
      replaceExistingBackup(file.name, item.remote, originalName);
    });
  } else {
    restoreOriginalButton.textContent = 'Restore Original Name';
    restoreOriginalButton.addEventListener('click', () => {
      byId(inputId).value = originalName;
      importBackup(file.name, remoteId, inputId);
    });
  }

  const restoreCloneButton = document.createElement('button');
  restoreCloneButton.textContent = 'Restore Clone';
  restoreCloneButton.title = 'Creates a new instance from this backup without affecting the existing instance.';
  restoreCloneButton.addEventListener('click', () => {
    importBackup(file.name, remoteId, inputId);
  });

  const deleteButton = document.createElement('button');
  deleteButton.textContent = 'Delete';
  deleteButton.title = 'Deletes this backup archive from the catalog.';
  deleteButton.className = 'danger';
  deleteButton.addEventListener('click', () => deleteBackup(file.name));

  controls.appendChild(restoreOriginalButton);
  controls.appendChild(restoreCloneButton);
  controls.appendChild(deleteButton);

  row.appendChild(cell);
  tbody.appendChild(row);
}


function renderBackups() {
  updateSortHeaders();

  const tbody = byId('backups');
  if (!tbody) return;

  const query = byId('backupSearch') ? byId('backupSearch').value || '' : '';
  tbody.innerHTML = '';

  const filtered = BACKUPS
    .filter((file) => !isBackupMatchedToCurrentContainer(file))
    .filter((file) => {
      const haystack = [
        file.name,
        file.size,
        String(file.ageDays),
        backupSource(file),
        getOriginalRestoreName(file),
        file.metadata ? JSON.stringify(file.metadata) : '',
      ].join(' ');

      return matchesSearch(haystack, query);
    })
    .sort(compareBackups);

  for (const file of filtered) {
    const tr = document.createElement('tr');

    const remoteId = 'orphan-remote-' + makeId(file.name);
    const inputId = 'orphan-restore-' + makeId(file.name);
    const defaultRemote = REMOTES[0] ? REMOTES[0].name : '';
    const restoreName = getCloneRestoreName(file, defaultRemote);

    tr.innerHTML =
      '<td><a href="' + file.url + '">' + escapeHtml(file.name) + '</a></td>' +
      '<td>' + escapeHtml(file.size || '') + '</td>' +
      '<td><span class="' + escapeAttr(file.ageStatus || '') + '">' + escapeHtml(String(file.ageDays)) + ' days</span></td>' +
      '<td>' + escapeHtml(backupSource(file)) + '</td>' +
      '<td><select id="' + remoteId + '">' + remoteOptions(defaultRemote) + '</select></td>' +
      '<td><input id="' + inputId + '" value="' + escapeAttr(restoreName) + '" /></td>' +
      '<td></td>';

    const actions = tr.children[6];

    const cloneButton = document.createElement('button');
    cloneButton.textContent = 'Restore Clone';
    cloneButton.addEventListener('click', () => importBackup(file.name, remoteId, inputId));

    const originalButton = document.createElement('button');
    originalButton.textContent = 'Restore Original Name';
    originalButton.title = 'Restores this backup using its original instance name when that name is available.';
    originalButton.addEventListener('click', () => {
      const selectedRemote = byId(remoteId).value;
      const originalName = getOriginalRestoreName(file);

      if (containerExists(selectedRemote, originalName)) {
        toast('Original container already exists on ' + selectedRemote + '. Use Restore Clone instead.', 'warn');
        return;
      }

      byId(inputId).value = originalName;
      importBackup(file.name, remoteId, inputId);
    });

    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'Delete';
    deleteButton.className = 'danger';
    deleteButton.addEventListener('click', () => deleteBackup(file.name));

    actions.appendChild(cloneButton);
    actions.appendChild(originalButton);
    actions.appendChild(deleteButton);

    tbody.appendChild(tr);
  }
}


async function loadBackups() {
  const data = await api('/api/backups');

  BACKUPS = data.files || [];

  byId('backupSummary').textContent = BACKUPS.length + ' cataloged backups';

  renderBackups();
  renderInstances();
}

async function loadJobs() {
  const data = await api('/api/jobs');

  JOBS = data.jobs || [];
  SERVER_EVENTS = data.events || [];

  byId('activeJobSummary').textContent = String(JOBS.filter((j) => j.status === 'running').length);
  byId('failedJobSummary').textContent = String(JOBS.filter((j) => j.status === 'failed').length);

  renderEvents();
  setMessage('');
  renderInstances();
}

async function exportBackup(remote, instance, backupMode, exportScope) {
  const mode = backupMode || 'live';
  const scope = exportScope || 'instance-only';

  toast('Export started for ' + remote + ':' + instance + ' (' + mode + ', ' + scope + ')', 'good');
  setMessage('');

  try {
    await api('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote, instance, backupMode: mode, exportScope: scope }),
    });

    toast('Export job queued', 'good');
    await loadJobs();
    startJobPolling();
  } catch (err) {
    setMessage('Export failed to start:\n' + err.message, true);
    toast('Export failed to start', 'bad');
  }
}


function simpleTimeToMinutes(value) {
  const parts = String(value || '02:00').split(':');
  const h = Math.max(0, Math.min(23, Number(parts[0] || 2)));
  const m = Math.max(0, Math.min(59, Number(parts[1] || 0)));
  return h * 60 + m;
}

function simpleMinutesToTime(total) {
  const day = 24 * 60;
  const value = ((Number(total || 0) % day) + day) % day;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function simpleAddMinutesToTime(value, offset) {
  return simpleMinutesToTime(simpleTimeToMinutes(value) + Number(offset || 0));
}

async function scheduleShownSimple() {
  const targets = getFilteredInstances();

  if (!targets.length) {
    toast('No instances are visible', 'warn');
    return;
  }

  const frequencyRaw = prompt(
    'Schedule ' + targets.length + ' visible instance(s).\\n\\nFrequency: daily, weekly, monthly, or off',
    'daily'
  );

  if (frequencyRaw === null) return;

  const frequency = String(frequencyRaw || 'daily').trim().toLowerCase();

  if (!['daily', 'weekly', 'monthly', 'off'].includes(frequency)) {
    toast('Invalid frequency. Use daily, weekly, monthly, or off.', 'bad');
    return;
  }

  let time = '02:00';
  let retentionCount = 7;
  let staggerMinutes = 5;
  let dayOfWeek = 0;
  let dayOfMonth = 1;

  if (frequency !== 'off') {
    const timeRaw = prompt('Start time for the first visible instance, HH:MM', '02:00');
    if (timeRaw === null) return;
    time = String(timeRaw || '02:00').trim();

    if (!/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
      toast('Invalid time. Use HH:MM, for example 02:00.', 'bad');
      return;
    }

    if (frequency === 'weekly') {
      const dowRaw = prompt('Day of week: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat', '0');
      if (dowRaw === null) return;
      dayOfWeek = Math.max(0, Math.min(6, Number(dowRaw || 0)));
    }

    if (frequency === 'monthly') {
      const domRaw = prompt('Day of month: 1-31', '1');
      if (domRaw === null) return;
      dayOfMonth = Math.max(1, Math.min(31, Number(domRaw || 1)));
    }

    const retentionRaw = prompt('Keep how many backups per instance?', '7');
    if (retentionRaw === null) return;
    retentionCount = Math.max(1, Math.min(365, Number(retentionRaw || 7)));

    const staggerRaw = prompt('Stagger each visible instance by how many minutes?', '5');
    if (staggerRaw === null) return;
    staggerMinutes = Math.max(0, Math.min(240, Number(staggerRaw || 0)));
  }

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    const scheduledTime = frequency === 'off' ? time : simpleAddMinutesToTime(time, i * staggerMinutes);

    try {
      await api('/api/settings/instance-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote: item.remote,
          instance: item.name,
          backupMode: getPolicyBackupMode(item.remote, item.name),
          exportScope: getPolicyExportScope(item.remote, item.name),
          schedule: {
            enabled: frequency !== 'off',
            frequency,
            everyHours: 24,
            time: scheduledTime,
            dayOfWeek,
            dayOfMonth,
            retentionCount,
            runMissed: false,
          },
        }),
      });

      ok += 1;
    } catch (err) {
      console.error(err);
      failed += 1;
    }
  }

  toast(
    frequency === 'off'
      ? 'Disabled schedules for ' + ok + ' instance(s)' + (failed ? ' · ' + failed + ' failed' : '')
      : 'Scheduled ' + ok + ' instance(s)' + (failed ? ' · ' + failed + ' failed' : ''),
    failed ? 'warn' : 'good'
  );

  await loadInstances();
}


async function exportAllShown() {
  const targets = getFilteredInstances();

  if (!targets.length) {
    toast('No instances are visible', 'warn');
    return;
  }

  if (!confirm('Queue backups for ' + targets.length + ' matching instance(s) using each instance policy?')) return;

  for (const item of targets) {
    const backupMode = getPolicyBackupMode(item.remote, item.name);
    const exportScope = getPolicyExportScope(item.remote, item.name);

    try {
      await api('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote: item.remote,
          instance: item.name,
          backupMode,
          exportScope,
        }),
      });
    } catch (err) {
      console.error(err);
    }
  }

  toast('Queued ' + targets.length + ' backup job(s)', 'good');
  await loadJobs();
  startJobPolling();
}

async function exportAllUnprotectedShown() {
  const targets = getFilteredInstances().filter((item) =>
    getBackupsForInstance(item.remote, item.name).length === 0
  );

  if (!targets.length) {
    toast('No unprotected instances are visible', 'warn');
    return;
  }

  if (!confirm('Queue backups for ' + targets.length + ' matching unprotected instance(s) using each instance policy?')) return;

  for (const item of targets) {
    try {
      await api('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote: item.remote,
          instance: item.name,
          backupMode: getPolicyBackupMode(item.remote, item.name),
          exportScope: getPolicyExportScope(item.remote, item.name),
        }),
      });
    } catch (err) {
      console.error(err);
    }
  }

  toast('Queued ' + targets.length + ' backup job(s)', 'good');
  await loadJobs();
  startJobPolling();
}

async function replaceExistingBackup(file, remote, name) {
  if (!remote) return alert('Missing destination remote.');
  if (!name) return alert('Missing original instance name.');

  const warning =
    'WARNING: This will replace the existing instance:\n\n' +
    remote + ':' + name + '\n\n' +
    'The current instance will be stopped if running, deleted, and restored from the selected backup.\n\n' +
    'Type REPLACE to continue.';

  const typed = prompt(warning);

  if (typed !== 'REPLACE') {
    toast('Replace cancelled', 'warn');
    return;
  }

  const data = await api('/api/replace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, remote, name }),
  });

  toast('Replace job queued', 'good');
  setMessage('');

  await loadJobs();
  renderInstances();
  startJobPolling();

  return data;
}

async function importBackup(file, remoteId, inputId) {
  const remote = byId(remoteId) ? byId(remoteId).value : '';
  const name = byId(inputId) ? byId(inputId).value : '';

  if (!remote) return alert('Choose a destination remote first.');
  if (!name) return alert('Enter a new container name first.');

  if (!confirm('Import ' + file + ' as ' + remote + ':' + name + '?')) return;

  await importBackupDirect(file, remote, name);
}

async function importBackupDirect(file, remote, name) {
  const data = await api('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, remote, name }),
  });

  toast('Import job queued', 'good');
  setMessage('');

  await loadJobs();
  await loadInstances();
  startJobPolling();

  return data;
}

async function deleteBackup(file) {
  if (!confirm('Delete backup file ' + file + '?')) return;

  try {
    await api('/api/backups/' + encodeURIComponent(file), { method: 'DELETE' });

    toast('Deleted ' + file, 'good');
    setMessage('');

    await loadBackups();
    await loadJobs();
  } catch (err) {
    setMessage('Delete failed:\n' + err.message, true);
    toast('Delete failed', 'bad');
  }
}

function startJobPolling() {
  if (JOB_TIMER) return;

  JOB_TIMER = setInterval(async () => {
    await loadJobs();
    await loadBackups();

    const hasRestoreJob = JOBS.some((j) =>
      j.status === 'running' && ['import', 'replace'].includes(j.type)
    );

    if (hasRestoreJob) {
      await loadInstances();
    }

    const running = JOBS.filter((j) => j.status === 'running').length;

    if (!running) {
      clearInterval(JOB_TIMER);
      JOB_TIMER = null;

      await loadBackups();
      await loadInstances();
      await loadHealth();
    }
  }, 3000);
}


function updateLastRefreshTime() {
  const now = new Date();

  const time = now.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });

  const el = byId('lastRefreshTime');
  if (el) {
    el.textContent = 'Last refreshed: ' + time;
  }
}

function timeToMinutes(value) {
  const parts = String(value || '02:00').split(':');
  const h = Math.max(0, Math.min(23, Number(parts[0] || 2)));
  const m = Math.max(0, Math.min(59, Number(parts[1] || 0)));
  return h * 60 + m;
}

function minutesToTime(total) {
  const day = 24 * 60;
  const value = ((Number(total || 0) % day) + day) % day;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function addMinutesToTime(value, offset) {
  return minutesToTime(timeToMinutes(value) + Number(offset || 0));
}

function updateBulkScheduleVisibility() {
  const frequency = byId('bulkScheduleFrequency') ? byId('bulkScheduleFrequency').value : 'off';

  document.querySelectorAll('[data-bulk-schedule-field]').forEach((field) => {
    const appliesTo = String(field.dataset.bulkScheduleField || '').split(',');
    field.classList.toggle('bulk-schedule-hidden', !appliesTo.includes(frequency));
  });

  const targets = getFilteredInstances();
  const applyButton = byId('applyBulkScheduleButton');
  if (applyButton) {
    applyButton.textContent =
      frequency === 'off'
        ? 'Disable Schedules for ' + targets.length + ' Instances'
        : 'Apply Schedule to ' + targets.length + ' Instances';
  }
}

function openBulkScheduleModal() {
  const targets = getFilteredInstances();

  if (!targets.length) {
    toast('No instances are visible', 'warn');
    return;
  }

  byId('bulkScheduleTitle').textContent = 'Schedule ' + targets.length + ' Shown';
  byId('bulkScheduleDescription').textContent =
    'Applies to the ' + targets.length + ' instances visible right now. Future filter changes will not change these schedules.';

  byId('bulkScheduleModal').classList.remove('hidden');
  updateBulkScheduleVisibility();
}

function closeBulkScheduleModal() {
  byId('bulkScheduleModal').classList.add('hidden');
}

async function applyBulkScheduleShown() {
  const targets = getFilteredInstances();
  const frequency = byId('bulkScheduleFrequency').value || 'off';
  const baseTime = byId('bulkScheduleTime').value || '02:00';
  const dayOfWeek = Number(byId('bulkScheduleDayOfWeek').value || 0);
  const dayOfMonth = Math.max(1, Math.min(31, Number(byId('bulkScheduleDayOfMonth').value || 1)));
  const retentionCount = Math.max(1, Math.min(365, Number(byId('bulkScheduleRetention').value || 7)));
  const staggerMinutes = Math.max(0, Number(byId('bulkScheduleStagger').value || 0));

  if (!targets.length) {
    toast('No instances are visible', 'warn');
    return;
  }

  if (!['off', 'daily', 'weekly', 'monthly'].includes(frequency)) {
    toast('Invalid bulk schedule frequency', 'bad');
    return;
  }

  const actionText =
    frequency === 'off'
      ? 'Disable schedules for ' + targets.length + ' visible instance(s)?'
      : 'Apply ' + frequency + ' schedules to ' + targets.length + ' visible instance(s)?';

  if (!confirm(actionText + '\\n\\nThis applies to the instances currently shown, not to a live filter rule.')) return;

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    const scheduledTime =
      frequency === 'off'
        ? baseTime
        : addMinutesToTime(baseTime, i * staggerMinutes);

    const backupMode = getPolicyBackupMode(item.remote, item.name);
    const exportScope = getPolicyExportScope(item.remote, item.name);

    try {
      await api('/api/settings/instance-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote: item.remote,
          instance: item.name,
          backupMode,
          exportScope,
          schedule: {
            enabled: frequency !== 'off',
            frequency,
            everyHours: 24,
            time: scheduledTime,
            dayOfWeek,
            dayOfMonth,
            retentionCount,
            runMissed: false,
          },
        }),
      });
      ok += 1;
    } catch (err) {
      console.error(err);
      failed += 1;
    }
  }

  closeBulkScheduleModal();

  toast(
    frequency === 'off'
      ? 'Disabled schedules for ' + ok + ' instance(s)' + (failed ? ' · ' + failed + ' failed' : '')
      : 'Applied schedules to ' + ok + ' instance(s)' + (failed ? ' · ' + failed + ' failed' : ''),
    failed ? 'warn' : 'good'
  );

  await loadInstances();
}

async function loadAll() {
  setMessage('');

  try {
    await loadBackups();
    await loadJobs();
    await loadHealth();
    await loadInstances();
    await loadBackups();
    await loadJobs();

    updateLastRefreshTime();

    setMessage('');
  } catch (err) {
    console.error(err);
    setMessage(err.message || String(err), true);
    toast('System error', 'bad');
  }
}

function setupClearableSearch(inputId, buttonId, renderFn) {
  const input = byId(inputId);
  const button = byId(buttonId);
  if (!input || !button) return;

  function updateClearButton() {
    button.classList.toggle('hidden', !input.value);
  }

  input.addEventListener('input', updateClearButton);

  button.addEventListener('click', () => {
    input.value = '';
    updateClearButton();
    input.focus();
    renderFn();
  });

  updateClearButton();
}

function wireEvents() {
  applyTheme(localStorage.getItem('incusBackupTheme') || 'dark');
  byId('themeToggle').addEventListener('click', toggleTheme);

  const donateButton = byId('donateButton');
  if (donateButton) {
    donateButton.addEventListener('click', () => {
      byId('donateModal').classList.remove('hidden');
    });
  }

  const closeDonateButton = byId('closeDonateButton');
  if (closeDonateButton) {
    closeDonateButton.addEventListener('click', () => {
      byId('donateModal').classList.add('hidden');
    });
  }

  byId('donateModal').addEventListener('click', (event) => {
    if (event.target.id === 'donateModal') byId('donateModal').classList.add('hidden');
  });

  const copyZelleButton = byId('copyZelleButton');
  if (copyZelleButton) {
    copyZelleButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText('vmsman@gmail.com');
      toast('Copied Zelle email', 'good');
    });
  }

  byId('refreshButton').addEventListener('click', loadAll);

  byId('backupAllShownButton').addEventListener('click', exportAllShown);
  byId('backupUnprotectedButton').addEventListener('click', exportAllUnprotectedShown);

  const scheduleShownButton = byId('scheduleShownButton');
  if (scheduleShownButton) {
    scheduleShownButton.addEventListener('click', scheduleShownSimple);
  }

  const bulkScheduleFrequency = byId('bulkScheduleFrequency');
  if (bulkScheduleFrequency) {
    bulkScheduleFrequency.addEventListener('change', updateBulkScheduleVisibility);
  }

  const closeBulkScheduleButton = byId('closeBulkScheduleButton');
  if (closeBulkScheduleButton) {
    closeBulkScheduleButton.addEventListener('click', closeBulkScheduleModal);
  }

  const applyBulkScheduleButton = byId('applyBulkScheduleButton');
  if (applyBulkScheduleButton) {
    applyBulkScheduleButton.addEventListener('click', applyBulkScheduleShown);
  }

  const bulkScheduleModal = byId('bulkScheduleModal');
  if (bulkScheduleModal) {
    bulkScheduleModal.addEventListener('click', (event) => {
      if (event.target.id === 'bulkScheduleModal') closeBulkScheduleModal();
    });
  }

  byId('quickUnprotected').addEventListener('click', () => {
    byId('protectionFilter').value = 'unprotected';
    renderInstances();
  });

  byId('quickFailed').addEventListener('click', () => {
    byId('protectionFilter').value = 'failedJobs';
    renderInstances();
  });

  byId('quickVMs').addEventListener('click', () => {
    byId('protectionFilter').value = 'vms';
    renderInstances();
  });

  byId('containerSearch').addEventListener('input', renderInstances);
  setupClearableSearch('containerSearch', 'clearContainerSearch', renderInstances);
  byId('remoteFilter').addEventListener('change', renderInstances);
  byId('statusFilter').addEventListener('change', renderInstances);
  byId('protectionFilter').addEventListener('change', renderInstances);
  byId('backupSearch').addEventListener('input', renderBackups);
  setupClearableSearch('backupSearch', 'clearBackupSearch', renderBackups);

  document.querySelectorAll('[data-instance-sort]').forEach((th) =>
    th.addEventListener('click', () => setInstanceSort(th.dataset.instanceSort))
  );

  document.querySelectorAll('[data-backup-sort]').forEach((th) =>
    th.addEventListener('click', () => setBackupSort(th.dataset.backupSort))
  );

  byId('uploadForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    const formData = new FormData(event.target);
    const remote = byId('uploadRemote').value || '';
    const restoreName = byId('uploadRestoreName').value || '';

    if (!remote) return alert('Choose the Incus server to import to first.');
    if (!restoreName) return alert('Enter the restore-as container name first.');

    toast('Uploading local backup file', 'good');
    setMessage('');

    try {
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await response.json();

      if (!data.ok) throw new Error(data.error || 'Upload failed');

      toast('Uploaded ' + data.file + '. Import started.', 'good');

      await importBackupDirect(data.file, remote, restoreName);

      event.target.reset();
      byId('uploadRestoreName').value = '';

      await loadBackups();
      await loadJobs();
    } catch (err) {
      setMessage('Upload/import failed:\n' + err.message, true);
      toast('Upload/import failed', 'bad');
    }
  });
}


function ensureBulkScheduleModalExists() {
  if (byId('bulkScheduleModal')) return;

  const modal = document.createElement('div');
  modal.id = 'bulkScheduleModal';
  modal.className = 'modal-backdrop hidden';
  modal.innerHTML =
    '<div class="modal-card bulk-schedule-card">' +
    '<h2 id="bulkScheduleTitle">Schedule Shown</h2>' +
    '<p class="muted" id="bulkScheduleDescription">Applies to the instances visible right now. Future filter changes will not change these schedules.</p>' +
    '<div class="bulk-schedule-grid">' +

    '<label><span>Frequency</span><select id="bulkScheduleFrequency">' +
    '<option value="off">Off / Disable schedules</option>' +
    '<option value="daily">Daily</option>' +
    '<option value="weekly">Weekly</option>' +
    '<option value="monthly">Monthly</option>' +
    '</select></label>' +

    '<label data-bulk-schedule-field="daily,weekly,monthly"><span>Start time</span><input id="bulkScheduleTime" type="time" value="02:00" /></label>' +

    '<label data-bulk-schedule-field="weekly"><span>Day of week</span><select id="bulkScheduleDayOfWeek">' +
    '<option value="0">Sun</option><option value="1">Mon</option><option value="2">Tue</option><option value="3">Wed</option>' +
    '<option value="4">Thu</option><option value="5">Fri</option><option value="6">Sat</option>' +
    '</select></label>' +

    '<label data-bulk-schedule-field="monthly"><span>Day of month</span><input id="bulkScheduleDayOfMonth" type="number" min="1" max="31" value="1" /></label>' +
    '<label data-bulk-schedule-field="daily,weekly,monthly"><span>Retention</span><input id="bulkScheduleRetention" type="number" min="1" max="365" value="7" /></label>' +

    '<label data-bulk-schedule-field="daily,weekly,monthly"><span>Stagger</span><select id="bulkScheduleStagger">' +
    '<option value="0">Do not stagger</option>' +
    '<option value="5" selected>5 minutes apart</option>' +
    '<option value="10">10 minutes apart</option>' +
    '<option value="15">15 minutes apart</option>' +
    '</select></label>' +

    '</div>' +
    '<div class="bulk-schedule-note">Backup mode and export scope will use each instance row&apos;s current saved setting.</div>' +
    '<div class="row" style="justify-content:flex-end;margin-top:14px;">' +
    '<button id="closeBulkScheduleButton" class="secondary" type="button">Cancel</button>' +
    '<button id="applyBulkScheduleButton" type="button">Apply Schedule</button>' +
    '</div>' +
    '</div>';

  document.body.appendChild(modal);

  byId('bulkScheduleFrequency').addEventListener('change', updateBulkScheduleVisibility);
  byId('closeBulkScheduleButton').addEventListener('click', closeBulkScheduleModal);
  byId('applyBulkScheduleButton').addEventListener('click', applyBulkScheduleShown);

  modal.addEventListener('click', (event) => {
    if (event.target.id === 'bulkScheduleModal') closeBulkScheduleModal();
  });
}

function timeToMinutes(value) {
  const parts = String(value || '02:00').split(':');
  const h = Math.max(0, Math.min(23, Number(parts[0] || 2)));
  const m = Math.max(0, Math.min(59, Number(parts[1] || 0)));
  return h * 60 + m;
}

function minutesToTime(total) {
  const day = 24 * 60;
  const value = ((Number(total || 0) % day) + day) % day;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function addMinutesToTime(value, offset) {
  return minutesToTime(timeToMinutes(value) + Number(offset || 0));
}

function updateBulkScheduleVisibility() {
  ensureBulkScheduleModalExists();

  const frequency = byId('bulkScheduleFrequency').value || 'off';

  document.querySelectorAll('[data-bulk-schedule-field]').forEach((field) => {
    const appliesTo = String(field.dataset.bulkScheduleField || '').split(',');
    field.classList.toggle('bulk-schedule-hidden', !appliesTo.includes(frequency));
  });

  const targets = getFilteredInstances();
  const applyButton = byId('applyBulkScheduleButton');

  if (applyButton) {
    applyButton.textContent =
      frequency === 'off'
        ? 'Disable Schedules for ' + targets.length + ' Instances'
        : 'Apply Schedule to ' + targets.length + ' Instances';
  }
}

function openBulkScheduleModal() {
  ensureBulkScheduleModalExists();

  const targets = getFilteredInstances();

  if (!targets.length) {
    toast('No instances are visible', 'warn');
    return;
  }

  byId('bulkScheduleTitle').textContent = 'Schedule ' + targets.length + ' Shown';
  byId('bulkScheduleDescription').textContent =
    'Applies to the ' + targets.length + ' instances visible right now. Future filter changes will not change these schedules.';

  byId('bulkScheduleModal').classList.remove('hidden');
  updateBulkScheduleVisibility();
}

function closeBulkScheduleModal() {
  const modal = byId('bulkScheduleModal');
  if (modal) modal.classList.add('hidden');
}

async function applyBulkScheduleShown() {
  const targets = getFilteredInstances();
  const frequency = byId('bulkScheduleFrequency').value || 'off';
  const baseTime = byId('bulkScheduleTime') ? byId('bulkScheduleTime').value || '02:00' : '02:00';
  const dayOfWeek = byId('bulkScheduleDayOfWeek') ? Number(byId('bulkScheduleDayOfWeek').value || 0) : 0;
  const dayOfMonth = byId('bulkScheduleDayOfMonth') ? Math.max(1, Math.min(31, Number(byId('bulkScheduleDayOfMonth').value || 1))) : 1;
  const retentionCount = byId('bulkScheduleRetention') ? Math.max(1, Math.min(365, Number(byId('bulkScheduleRetention').value || 7))) : 7;
  const staggerMinutes = byId('bulkScheduleStagger') ? Math.max(0, Number(byId('bulkScheduleStagger').value || 0)) : 0;

  if (!targets.length) {
    toast('No instances are visible', 'warn');
    return;
  }

  if (!['off', 'daily', 'weekly', 'monthly'].includes(frequency)) {
    toast('Invalid schedule frequency', 'bad');
    return;
  }

  const prompt =
    frequency === 'off'
      ? 'Disable schedules for ' + targets.length + ' visible instance(s)?'
      : 'Apply ' + frequency + ' schedules to ' + targets.length + ' visible instance(s)?';

  if (!confirm(prompt + '\\n\\nThis applies to the instances currently shown, not to a live filter rule.')) return;

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    const scheduledTime =
      frequency === 'off'
        ? baseTime
        : addMinutesToTime(baseTime, i * staggerMinutes);

    try {
      await api('/api/settings/instance-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote: item.remote,
          instance: item.name,
          backupMode: getPolicyBackupMode(item.remote, item.name),
          exportScope: getPolicyExportScope(item.remote, item.name),
          schedule: {
            enabled: frequency !== 'off',
            frequency,
            everyHours: 24,
            time: scheduledTime,
            dayOfWeek,
            dayOfMonth,
            retentionCount,
            runMissed: false,
          },
        }),
      });
      ok += 1;
    } catch (err) {
      console.error(err);
      failed += 1;
    }
  }

  closeBulkScheduleModal();

  toast(
    frequency === 'off'
      ? 'Disabled schedules for ' + ok + ' instance(s)' + (failed ? ' · ' + failed + ' failed' : '')
      : 'Applied schedules to ' + ok + ' instance(s)' + (failed ? ' · ' + failed + ' failed' : ''),
    failed ? 'warn' : 'good'
  );

  await loadInstances();
}



function sbBulkTimeToMinutes(value) {
  const parts = String(value || '02:00').split(':');
  const h = Math.max(0, Math.min(23, Number(parts[0] || 2)));
  const m = Math.max(0, Math.min(59, Number(parts[1] || 0)));
  return h * 60 + m;
}

function sbBulkMinutesToTime(total) {
  const day = 24 * 60;
  const value = ((Number(total || 0) % day) + day) % day;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function sbBulkAddMinutesToTime(value, offset) {
  return sbBulkMinutesToTime(sbBulkTimeToMinutes(value) + Number(offset || 0));
}

function ensureSbBulkSchedulePanel() {
  let panel = byId('sbBulkSchedulePanel');
  if (panel) return panel;

  const controls = document.querySelector('.row.controls');
  if (!controls || !controls.parentNode) return null;

  panel = document.createElement('div');
  panel.id = 'sbBulkSchedulePanel';
  panel.className = 'bulk-inline-panel hidden';
  panel.innerHTML =
    '<div class="backup-detail-header">' +
      '<div>' +
        '<div id="sbBulkScheduleTitle" class="backup-detail-title">Schedule Shown</div>' +
        '<div id="sbBulkScheduleDescription" class="backup-detail-meta">Applies to the instances visible right now. Future filter changes will not change these schedules.</div>' +
      '</div>' +
    '</div>' +

    '<div class="schedule-editor-grid">' +
      '<div class="schedule-field">' +
        '<label>Frequency</label>' +
        '<select id="sbBulkFrequency">' +
          '<option value="off">Off</option>' +
          '<option value="hourly">Every N hours</option>' +
          '<option value="daily" selected>Daily</option>' +
          '<option value="weekly">Weekly</option>' +
          '<option value="monthly">Monthly</option>' +
        '</select>' +
      '</div>' +

      '<div class="schedule-field" data-sb-bulk-field="hourly">' +
        '<label>Every how many hours?</label>' +
        '<input id="sbBulkEveryHours" type="number" min="1" max="168" value="24" />' +
      '</div>' +

      '<div class="schedule-field" data-sb-bulk-field="daily,weekly,monthly">' +
        '<label>Start time</label>' +
        '<input id="sbBulkTime" type="time" value="02:00" />' +
      '</div>' +

      '<div class="schedule-field" data-sb-bulk-field="weekly">' +
        '<label>Day of week</label>' +
        '<select id="sbBulkDayOfWeek">' +
          '<option value="0">Sunday</option>' +
          '<option value="1">Monday</option>' +
          '<option value="2">Tuesday</option>' +
          '<option value="3">Wednesday</option>' +
          '<option value="4">Thursday</option>' +
          '<option value="5">Friday</option>' +
          '<option value="6">Saturday</option>' +
        '</select>' +
      '</div>' +

      '<div class="schedule-field" data-sb-bulk-field="monthly">' +
        '<label>Day of month</label>' +
        '<input id="sbBulkDayOfMonth" type="number" min="1" max="31" value="1" />' +
      '</div>' +

      '<div class="schedule-field" data-sb-bulk-field="hourly,daily,weekly,monthly">' +
        '<label>Keep backups</label>' +
        '<input id="sbBulkRetention" type="number" min="1" max="365" value="7" />' +
      '</div>' +

      '<div class="schedule-field" data-sb-bulk-field="hourly,daily,weekly,monthly">' +
        '<label>Stagger each instance</label>' +
        '<select id="sbBulkStagger">' +
          '<option value="0">Do not stagger</option>' +
          '<option value="5" selected>5 minutes apart</option>' +
          '<option value="10">10 minutes apart</option>' +
          '<option value="15">15 minutes apart</option>' +
        '</select>' +
      '</div>' +

      '<label class="schedule-check" data-sb-bulk-field="hourly,daily,weekly,monthly">' +
        '<input id="sbBulkRunMissed" type="checkbox" />' +
        '<span>Run missed backup after downtime</span>' +
      '</label>' +

      '<button id="sbApplyBulkScheduleButton" type="button">Apply Schedule</button>' +
      '<button id="sbCloseBulkScheduleButton" class="secondary" type="button">Cancel</button>' +
    '</div>' +

    '<div class="bulk-schedule-note">Backup mode and export scope use each row&apos;s current setting. This schedules the currently shown instances only.</div>';

  controls.insertAdjacentElement('afterend', panel);

  byId('sbBulkFrequency').addEventListener('change', updateSbBulkScheduleVisibility);
  byId('sbApplyBulkScheduleButton').addEventListener('click', applySbBulkSchedule);
  byId('sbCloseBulkScheduleButton').addEventListener('click', closeSbBulkSchedulePanel);

  updateSbBulkScheduleVisibility();
  return panel;
}

function updateSbBulkScheduleVisibility() {
  const frequency = byId('sbBulkFrequency') ? byId('sbBulkFrequency').value : 'daily';

  document.querySelectorAll('[data-sb-bulk-field]').forEach((field) => {
    const appliesTo = String(field.dataset.sbBulkField || '').split(',');
    field.classList.toggle('schedule-hidden', !appliesTo.includes(frequency));
  });

  const targets = getFilteredInstances();
  const applyButton = byId('sbApplyBulkScheduleButton');
  if (applyButton) {
    applyButton.textContent =
      frequency === 'off'
        ? 'Disable Schedules for ' + targets.length + ' Shown'
        : 'Apply Schedule to ' + targets.length + ' Shown';
  }
}

function openSbBulkSchedulePanel() {
  const targets = getFilteredInstances();

  if (!targets.length) {
    toast('No instances are visible', 'warn');
    return;
  }

  const panel = ensureSbBulkSchedulePanel();
  if (!panel) {
    toast('Could not create bulk schedule panel', 'bad');
    return;
  }

  byId('sbBulkScheduleTitle').textContent = 'Schedule ' + targets.length + ' Shown';
  byId('sbBulkScheduleDescription').textContent =
    'Applies to the ' + targets.length + ' instances visible right now. Future filter changes will not change these schedules.';

  byId('sbBulkFrequency').value = 'daily';
  panel.classList.remove('hidden');
  updateSbBulkScheduleVisibility();
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeSbBulkSchedulePanel() {
  const panel = byId('sbBulkSchedulePanel');
  if (panel) panel.classList.add('hidden');
}

async function applySbBulkSchedule() {
  const targets = getFilteredInstances();

  if (!targets.length) {
    toast('No instances are visible', 'warn');
    return;
  }

  const frequency = byId('sbBulkFrequency').value || 'daily';
  const everyHours = Math.max(1, Math.min(168, Number(byId('sbBulkEveryHours').value || 24)));
  const time = byId('sbBulkTime').value || '02:00';
  const dayOfWeek = Math.max(0, Math.min(6, Number(byId('sbBulkDayOfWeek').value || 0)));
  const dayOfMonth = Math.max(1, Math.min(31, Number(byId('sbBulkDayOfMonth').value || 1)));
  const retentionCount = Math.max(1, Math.min(365, Number(byId('sbBulkRetention').value || 7)));
  const staggerMinutes = Math.max(0, Math.min(240, Number(byId('sbBulkStagger').value || 0)));
  const runMissed = Boolean(byId('sbBulkRunMissed').checked);

  if (!['off', 'hourly', 'daily', 'weekly', 'monthly'].includes(frequency)) {
    toast('Invalid schedule frequency', 'bad');
    return;
  }

  if (frequency !== 'off' && !/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
    toast('Invalid time. Use HH:MM, for example 02:00.', 'bad');
    return;
  }

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    const scheduledTime =
      frequency === 'off'
        ? time
        : sbBulkAddMinutesToTime(time, i * staggerMinutes);

    try {
      await api('/api/settings/instance-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote: item.remote,
          instance: item.name,
          backupMode: getPolicyBackupMode(item.remote, item.name),
          exportScope: getPolicyExportScope(item.remote, item.name),
          schedule: {
            enabled: frequency !== 'off',
            frequency,
            everyHours,
            time: scheduledTime,
            dayOfWeek,
            dayOfMonth,
            retentionCount,
            runMissed,
          },
        }),
      });
      ok += 1;
    } catch (err) {
      console.error(err);
      failed += 1;
    }
  }

  toast(
    frequency === 'off'
      ? 'Disabled schedules for ' + ok + ' instance(s)' + (failed ? ' · ' + failed + ' failed' : '')
      : 'Scheduled ' + ok + ' instance(s)' + (failed ? ' · ' + failed + ' failed' : ''),
    failed ? 'warn' : 'good'
  );

  closeSbBulkSchedulePanel();
  await loadInstances();
}

/*
  This capture-phase handler intentionally overrides older Schedule Shown handlers.
  It prevents the old prompt-based handler from firing.
*/
document.addEventListener('click', (event) => {
  const button = event.target.closest && event.target.closest('#scheduleShownButton');
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  openSbBulkSchedulePanel();
}, true);



function sbIsSelfBackupInstanceName(name) {
  return String(name || '').toLowerCase() === 'incusbackup';
}

async function enforceSelfBackupUiProtection() {
  let changed = false;

  document.querySelectorAll('select[data-backup-mode], select[data-ui-key]').forEach((select) => {
    const raw = select.getAttribute('data-backup-mode') || select.getAttribute('data-ui-key') || '';
    const parts = raw.split('|');
    const remote = parts[0] || '';
    const instance = parts.slice(1).join('|') || '';

    if (!sbIsSelfBackupInstanceName(instance)) return;

    if (select.value !== 'live') {
      select.value = 'live';
      changed = true;
    }

    select.disabled = true;
    select.title = 'Self-protected: IncusBackup must use Live mode so it cannot stop the backup application.';

    const liveOption = Array.from(select.options).find((option) => option.value === 'live');
    if (liveOption && !liveOption.textContent.includes('self protected')) {
      liveOption.textContent = 'Live - self protected';
    }

    const policy = getInstancePolicy(remote, instance);
    if (policy && policy.backupMode === 'stop-restart') {
      api('/api/settings/instance-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote,
          instance,
          backupMode: 'live',
          exportScope: policy.exportScope || 'instance-only',
          schedule: policy.schedule || undefined,
        }),
      }).catch((err) => console.error(err));
    }
  });

  if (changed) {
    toast('Self-protection forced IncusBackup backup mode to Live', 'warn');
  }
}



function sbSelfProtectIsIncusBackup(name) {
  return String(name || '').toLowerCase() === 'incusbackup';
}

function sbSelfProtectParseModeSelect(select) {
  const raw = select ? String(select.getAttribute('data-backup-mode') || select.getAttribute('data-ui-key') || '') : '';
  const parts = raw.split('|');
  return {
    remote: parts[0] || '',
    instance: parts.slice(1).join('|') || '',
  };
}

function sbSelfProtectApply() {
  document.querySelectorAll('select[data-backup-mode], select[data-ui-key]').forEach((select) => {
    const parsed = sbSelfProtectParseModeSelect(select);
    if (!sbSelfProtectIsIncusBackup(parsed.instance)) return;

    select.value = 'live';
    select.disabled = true;
    select.title = 'Self-protected: IncusBackup must use Live mode so it cannot stop the backup application.';

    Array.from(select.options).forEach((option) => {
      if (option.value === 'live') option.textContent = 'Live - self protected';
      if (option.value === 'stop-restart') option.disabled = true;
    });

    const policy = getInstancePolicy(parsed.remote, parsed.instance);
    if (policy && policy.backupMode === 'stop-restart') {
      policy.backupMode = 'live';

      api('/api/settings/instance-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote: parsed.remote,
          instance: parsed.instance,
          backupMode: 'live',
          exportScope: policy.exportScope || 'instance-only',
          schedule: policy.schedule || undefined,
        }),
      }).catch((err) => console.error(err));
    }
  });
}

document.addEventListener('change', (event) => {
  const select = event.target && event.target.closest && event.target.closest('select[data-backup-mode]');
  if (!select) return;

  const parsed = sbSelfProtectParseModeSelect(select);
  if (!sbSelfProtectIsIncusBackup(parsed.instance)) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  select.value = 'live';
  sbSelfProtectApply();
  toast('Self-protection: IncusBackup must use Live mode', 'warn');
}, true);


window.addEventListener('DOMContentLoaded', () => {
  wireEvents();
  loadAll();
});
`;

app.get('/', (req, res) => res.type('html').send(indexHtml));
app.get('/style.css', (req, res) => res.type('text/css').send(styleCss));
app.get('/app.js', (req, res) => res.type('application/javascript').send(appJs));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('ScottiBYTE Incus Backup running at http://0.0.0.0:' + PORT);
  console.log('Backup directory: ' + BACKUP_DIR);
  console.log('Completed jobs auto-hide after ' + Math.round(COMPLETED_JOB_TTL_MS / 1000) + ' seconds.');
  startScheduler();
});

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

