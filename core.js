// 听澜 4.1 可测试核心：噪声、滤波、播放时钟、导出评估与数据校验。
export const APP_VERSION = '4.1';

export const PLAYER_STATES = ['IDLE', 'STARTING', 'PLAYING', 'PAUSING', 'PAUSED', 'STOPPING', 'ERROR'];

const TRANSITIONS = {
  IDLE: ['STARTING'],
  STARTING: ['PLAYING', 'STOPPING', 'ERROR'],
  PLAYING: ['PAUSING', 'STOPPING', 'ERROR'],
  PAUSING: ['PAUSED', 'STOPPING', 'ERROR'],
  PAUSED: ['STARTING', 'STOPPING', 'ERROR'],
  STOPPING: ['IDLE', 'ERROR'],
  ERROR: ['IDLE']
};

export const END_REASONS = ['completed', 'manual', 'discomfort', 'error', 'interrupted'];

export const TRACK_KINDS = ['pink', 'brown', 'white', 'rain', 'stream', 'band', 'notch', 'file'];

export const REPLACE_FADE = { old: 0.18, delay: 0.04, fade: 0.22 };

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function clamp(x, lo, hi) {
  const n = +x;
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

export function octQ(octaves) {
  return 1 / (2 * Math.sinh(Math.LN2 * octaves / 2));
}

export function masterGain(volume) {
  return 0.17 * Math.pow(clamp(volume, 0, 100) / 100, 1.3);
}

export function trackGain(level, audibleCount) {
  const n = Math.max(1, audibleCount | 0);
  return 0.54 * (clamp(level, 0, 100) / 100) / Math.sqrt(n);
}

export function noiseLength(kind, sampleRate) {
  const seconds = kind === 'rain' ? 8 * Math.PI
    : kind === 'stream' ? 6 * Math.PI / 1.7
    : 12;
  return Math.max(1, Math.round(sampleRate * seconds));
}

function randStep(state) {
  let x = state.x;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.x = x;
  return (x >>> 0) / 4294967296;
}

export function fillNoise(kind, length, sampleRate, seed, channel = 0) {
  const fade = Math.floor(sampleRate * 0.4);
  const total = length + fade;
  const raw = new Float32Array(total);
  const state = { x: (0x6d2b79f5 ^ ((seed + 1) * 98231) ^ (channel * 3391)) | 0 };
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0, slow = 0;
  for (let i = 0; i < total; i++) {
    const w = randStep(state) * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.085;
    b6 = w * 0.115926;
    brown = clamp((brown + w * 0.024) * 0.997, -3, 3);
    slow = slow * 0.996 + w * 0.004;
    const t = i / sampleRate;
    let z = w * 0.26;
    if (kind === 'brown') z = brown * 0.43;
    else if (kind === 'pink') z = pink * 0.62;
    else if (kind === 'rain') z = (pink * 0.35 + w * 0.08) * (0.83 + 0.15 * Math.sin(t * 2 + channel));
    else if (kind === 'stream') z = (pink * 0.51 + brown * 0.13 + slow * 0.1) * (0.78 + 0.2 * Math.sin(t * 1.7 + channel));
    raw[i] = z * 2.2;
  }
  const out = raw.slice(0, length);
  for (let i = 0; i < fade; i++) {
    const u = i / fade;
    const keep = Math.sin(u * Math.PI / 2);
    const cont = Math.cos(u * Math.PI / 2);
    out[i] = raw[i] * keep + raw[length + i] * cont;
  }
  return out;
}

export function boundaryStepRatio(samples) {
  const n = samples.length;
  if (n < 3) return Infinity;
  const jump = Math.abs(samples[n - 1] - samples[0]);
  const diffs = [];
  const step = Math.max(1, Math.floor(n / 4000));
  for (let i = 0; i < n - 1; i += step) diffs.push(Math.abs(samples[i + 1] - samples[i]));
  diffs.sort((a, b) => a - b);
  const median = diffs[diffs.length >> 1] || 1e-9;
  return jump / median;
}

export function replacementGainRatio(gain = 1) {
  const { old, delay, fade } = REPLACE_FADE;
  const total = delay + fade;
  let max = 0;
  for (let i = 0; i <= 200; i++) {
    const t = total * i / 200;
    const oldG = t >= old ? 0 : gain * (1 - t / old);
    const newG = t < delay ? 0 : gain * Math.min(1, (t - delay) / fade);
    max = Math.max(max, oldG + newG);
  }
  return max / gain;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const idx = i + k + half;
        const vRe = re[idx] * wRe - im[idx] * wIm;
        const vIm = re[idx] * wIm + im[idx] * wRe;
        const uRe = re[i + k];
        const uIm = im[i + k];
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[idx] = uRe - vRe;
        im[idx] = uIm - vIm;
        const nextRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextRe;
      }
    }
  }
}

export function spectralSlopeDbPerOctave(samples, sampleRate) {
  const n = 16384;
  const hop = 8192;
  const bins = n >> 1;
  const power = new Float64Array(bins);
  let windows = 0;
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  for (let start = 0; start + n <= samples.length; start += hop) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = samples[start + i] * window[i];
    fft(re, im);
    for (let k = 1; k < bins; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    windows++;
    if (windows >= 8) break;
  }
  if (!windows) return NaN;
  const xs = [];
  const ys = [];
  const fLo = 250;
  const fHi = Math.min(8000, sampleRate * 0.45);
  const bands = 24;
  for (let b = 0; b < bands; b++) {
    const f0 = fLo * Math.pow(fHi / fLo, b / bands);
    const f1 = fLo * Math.pow(fHi / fLo, (b + 1) / bands);
    const i0 = Math.max(1, Math.floor(f0 * n / sampleRate));
    const i1 = Math.min(bins - 1, Math.ceil(f1 * n / sampleRate));
    if (i1 <= i0) continue;
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += power[i];
    const fc = Math.sqrt(f0 * f1);
    xs.push(Math.log2(fc));
    ys.push(10 * Math.log10(sum / ((i1 - i0) * windows) + 1e-20));
  }
  const count = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < count; i++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  const denom = count * sxx - sx * sx;
  return denom ? (count * sxy - sx * sy) / denom : NaN;
}

export function biquadCoefficients(type, frequency, Q, sampleRate) {
  const w0 = 2 * Math.PI * frequency / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (type === 'notch') {
    b0 = 1; b1 = -2 * cos; b2 = 1;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else {
    throw new Error('不支持的滤波器类型');
  }
  return { b: [b0 / a0, b1 / a0, b2 / a0], a: [1, a1 / a0, a2 / a0] };
}

export function magnitudeDb(coeff, frequency, sampleRate) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const [b0, b1, b2] = coeff.b;
  const a1 = coeff.a[1], a2 = coeff.a[2];
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -(b1 * s1 + b2 * s2);
  const dr = 1 + a1 * c1 + a2 * c2;
  const di = -(a1 * s1 + a2 * s2);
  const mag = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  return 20 * Math.log10(Math.max(mag, 1e-12));
}

function logGrid(sampleRate) {
  const nyq = sampleRate / 2;
  const points = [];
  const count = 2400;
  for (let i = 0; i < count; i++) {
    const f = 30 * Math.pow((nyq * 0.98) / 30, i / (count - 1));
    points.push(f);
  }
  return points;
}

function crossing(freqs, dbs, i0, i1, target) {
  const dir = i1 > i0 ? 1 : -1;
  for (let i = i0; i !== i1; i += dir) {
    const next = i + dir;
    const y0 = dbs[i];
    const y1 = dbs[next];
    if ((y0 - target) * (y1 - target) <= 0 && y0 !== y1) {
      const t = (target - y0) / (y1 - y0);
      return freqs[i] + (freqs[next] - freqs[i]) * t;
    }
  }
  return null;
}

export function measureFilter({ type, freq, bw, sampleRate = 44100 }) {
  const Q = octQ(bw);
  const coeff = biquadCoefficients(type, freq, Q, sampleRate);
  const freqs = logGrid(sampleRate);
  const dbs = freqs.map(f => magnitudeDb(coeff, f, sampleRate));
  let centerHz = freq;
  let peakDb = magnitudeDb(coeff, freq, sampleRate);
  for (let i = -40; i <= 40; i++) {
    const f = freq * 2 ** (i * 0.002);
    if (f <= 20 || f >= sampleRate / 2) continue;
    const db = magnitudeDb(coeff, f, sampleRate);
    const better = type === 'notch' ? db < peakDb : db > peakDb;
    if (better) { peakDb = db; centerHz = f; }
  }
  let centerIndex = 0;
  let centerDistance = Infinity;
  for (let i = 0; i < freqs.length; i++) {
    const distance = Math.abs(Math.log2(freqs[i] / centerHz));
    if (distance < centerDistance) { centerDistance = distance; centerIndex = i; }
  }
  const target = type === 'notch' ? -3 : peakDb - 3;
  const lower = crossing(freqs, dbs, centerIndex, 0, target);
  const upper = crossing(freqs, dbs, centerIndex, freqs.length - 1, target);
  const nyq = sampleRate / 2;
  const reliable = lower != null && upper != null && upper < nyq * 0.45 && lower > 40 && upper > lower;
  return {
    centerHz,
    attenuationDb: type === 'notch' ? peakDb : null,
    peakDb,
    bandwidthOct: reliable ? Math.log2(upper / lower) : null,
    lowerHz: lower,
    upperHz: upper,
    reliable,
    curve: freqs.filter((_, i) => i % 8 === 0).map((f, i) => ({ f, db: dbs[i * 8] }))
  };
}

export function responseCurve(type, freq, bw, sampleRate = 44100) {
  const coeff = biquadCoefficients(type, freq, octQ(bw), sampleRate);
  const points = [];
  for (let i = 0; i <= 160; i++) {
    const f = 80 * Math.pow(14000 / 80, i / 160);
    points.push({ f, db: magnitudeDb(coeff, f, sampleRate) });
  }
  return points;
}

export function createClock() {
  let playerAccum = 0;
  let playerMark = null;
  let audioAccum = 0;
  let audioMark = null;
  return {
    startPlayer(now) { playerMark = now; },
    pausePlayer(now) {
      if (playerMark != null) {
        playerAccum += Math.max(0, now - playerMark);
        playerMark = null;
      }
    },
    noteAudio(ctxTime, running) {
      if (running) {
        if (audioMark == null) audioMark = ctxTime;
        return;
      }
      if (audioMark != null) {
        audioAccum += Math.max(0, ctxTime - audioMark);
        audioMark = null;
      }
    },
    playerSeconds(now) {
      const extra = playerMark == null ? 0 : Math.max(0, now - playerMark);
      return (playerAccum + extra) / 1000;
    },
    audioSeconds(ctxTime, running) {
      const extra = running && audioMark != null ? Math.max(0, ctxTime - audioMark) : 0;
      return audioAccum + extra;
    },
    confirmedSeconds(now, ctxTime, running) {
      return Math.min(this.playerSeconds(now), this.audioSeconds(ctxTime, running));
    },
    reset() {
      playerAccum = 0;
      playerMark = null;
      audioAccum = 0;
      audioMark = null;
    }
  };
}

export function protectionDecision({ peak, safetyGain, strikes, nonFinite = 0 }) {
  if (nonFinite > 0 || !Number.isFinite(peak)) {
    return { action: 'stop', reason: 'nonfinite', safetyGain, strikes: strikes + 1 };
  }
  if (peak > 1.02 || (safetyGain <= 0.36 && peak > 0.98)) {
    return { action: 'stop', reason: 'peak', safetyGain: Math.max(0.35, safetyGain * 0.5), strikes: strikes + 1 };
  }
  if (peak > 0.94) {
    const nextStrikes = strikes + 1;
    if (nextStrikes >= 4) {
      return { action: 'duck', safetyGain: Math.max(0.35, safetyGain * 0.85), strikes: nextStrikes };
    }
    return { action: 'hold', safetyGain, strikes: nextStrikes };
  }
  return { action: 'clear', safetyGain, strikes: Math.max(0, strikes - 1) };
}

export function analyzeChannels(channels, sampleRate) {
  const left = channels[0];
  const right = channels[1] || channels[0];
  const n = Math.min(left.length, right.length);
  let peak = 0, sumSq = 0, count = 0, clips = 0, nonFinite = 0, truePeak = 0;
  for (let i = 0; i < n; i++) {
    for (const x of [left[i], right[i]]) {
      if (!Number.isFinite(x)) { nonFinite++; continue; }
      const ax = Math.abs(x);
      if (ax > peak) peak = ax;
      if (ax >= 1) clips++;
      sumSq += x * x;
      count++;
    }
    if (i > 0 && i < n - 2) {
      for (const ch of [left, right]) {
        truePeak = Math.max(truePeak, interpolatedPeak(ch[i - 1], ch[i], ch[i + 1], ch[i + 2]));
      }
    }
  }
  truePeak = Math.max(truePeak, peak);
  return {
    peak,
    truePeak,
    rms: count ? Math.sqrt(sumSq / count) : 0,
    clips,
    nonFinite,
    sampleRate,
    samples: count
  };
}

function interpolatedPeak(y0, y1, y2, y3) {
  if (![y0, y1, y2, y3].every(Number.isFinite)) return 0;
  let max = Math.max(Math.abs(y1), Math.abs(y2));
  for (const t of [0.25, 0.5, 0.75]) {
    const t2 = t * t;
    const t3 = t2 * t;
    const v = 0.5 * ((2 * y1) + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
    max = Math.max(max, Math.abs(v));
  }
  return max;
}

export function assessExport(analysis) {
  if (!analysis || analysis.nonFinite > 0) return { ok: false, reason: '音频包含非有限数值，已取消导出' };
  if (analysis.clips > 0 || analysis.peak > 1 || analysis.truePeak > 1) {
    return { ok: false, reason: '检测到削波或真峰值超过满幅，已取消导出。请降低数字增益后重试' };
  }
  return { ok: true };
}

export function exportAllowance(seconds, { deviceMemory = 8, mobile = false } = {}) {
  const allowed = [10, 30, 60, 120];
  if (!allowed.includes(seconds)) return { ok: false, reason: '不支持的导出时长' };
  const limit = mobile || (deviceMemory && deviceMemory <= 2) ? 30 : 120;
  if (seconds > limit) return { ok: false, reason: `当前设备请导出 ${limit} 秒以内，以避免内存不足` };
  const bytes = seconds * 44100 * 2 * 4;
  if (bytes > 48 * 1024 * 1024) return { ok: false, reason: '导出超出内存预算' };
  return { ok: true, bytes };
}

export function encodeWav(left, right, sampleRate) {
  const n = Math.min(left.length, right.length);
  const out = new ArrayBuffer(44 + n * 4);
  const view = new DataView(out);
  let p = 0;
  const str = text => { for (const c of text) view.setUint8(p++, c.charCodeAt(0)); };
  const u16 = x => { view.setUint16(p, x, true); p += 2; };
  const u32 = x => { view.setUint32(p, x, true); p += 4; };
  str('RIFF'); u32(out.byteLength - 8); str('WAVE'); str('fmt ');
  u32(16); u16(1); u16(2); u32(sampleRate); u32(sampleRate * 4); u16(4); u16(16);
  str('data'); u32(n * 4);
  for (let i = 0; i < n; i++) {
    for (const q of [left[i], right[i]]) {
      const x = clamp(q, -1, 1);
      view.setInt16(p, x < 0 ? x * 32768 : x * 32767, true);
      p += 2;
    }
  }
  return out;
}

export function voiceSpec(track, audibleCount) {
  const filtered = track.kind === 'band' || track.kind === 'notch';
  return {
    source: filtered ? 'white' : track.kind,
    filter: track.kind === 'band' ? 'bandpass' : track.kind === 'notch' ? 'notch' : null,
    frequency: track.freq,
    Q: filtered ? octQ(track.bw) : null,
    cutoff: track.cutoff,
    pan: track.pan / 100,
    gain: trackGain(track.level, audibleCount)
  };
}

export function snapshotSettings(settings) {
  return {
    volume: settings.volume,
    duration: settings.duration,
    fadeIn: settings.fadeIn,
    fadeOut: settings.fadeOut,
    activeName: settings.activeName,
    activeId: settings.activeId,
    tracks: (settings.tracks || []).map(t => ({
      id: t.id, kind: t.kind, level: t.level, pan: t.pan, freq: t.freq, bw: t.bw,
      cutoff: t.cutoff, mute: !!t.mute, solo: !!t.solo, fileName: t.fileName || ''
    }))
  };
}

export function pushParamEvent(events, event, limit = 400) {
  const prev = events[events.length - 1];
  if (prev && prev.path === event.path && JSON.stringify(prev.value) === JSON.stringify(event.value) && event.t - prev.t < 0.3) {
    return events;
  }
  const next = events.concat(event);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function csvCell(value, text = false) {
  let s = String(value ?? '');
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}

export function recordsToCsv(sessions, logs) {
  const cols = ['类型', '日期', '方案', '时长（秒）', '播放前困扰', '播放后困扰', '入睡分钟', '备注', '结束原因', '会话ID'];
  const rows = [cols];
  for (const x of sessions) {
    rows.push(['声音使用', x.date, x.name, x.confirmedSeconds ?? x.seconds, '', '', '', x.tracks || '', x.endReason || '', x.id || '']);
  }
  for (const x of logs) {
    rows.push(['自评', x.date, x.mix || '', '', x.before, x.after, x.sleep ?? '', x.notes || '', '', x.sessionId || '']);
  }
  return '\ufeff' + rows.map(row => row.map(value => csvCell(value, typeof value === 'string')).join(',')).join('\r\n');
}

export function sanitizeTrack(t) {
  const kind = t && TRACK_KINDS.includes(t.kind) ? t.kind : 'pink';
  return {
    id: t && typeof t.id === 'string' ? t.id.slice(0, 40) : '',
    kind,
    level: clamp(t?.level ?? 30, 0, 100),
    pan: clamp(t?.pan ?? 0, -100, 100),
    freq: clamp(t?.freq ?? 4000, 250, 8000),
    bw: clamp(t?.bw ?? 1, 0.2, 3),
    cutoff: clamp(t?.cutoff ?? 8000, 1000, 14000),
    mute: !!t?.mute,
    solo: !!t?.solo,
    fileName: String(t?.fileName || '').slice(0, 70)
  };
}

export function sanitizeSettings(settings) {
  const src = settings && typeof settings === 'object' ? settings : {};
  const tracks = Array.isArray(src.tracks) ? src.tracks.slice(0, 6).map(sanitizeTrack) : [];
  return {
    volume: clamp(src.volume ?? 18, 0, 100),
    duration: clamp(src.duration ?? 30, 15, 90),
    fadeIn: clamp(src.fadeIn ?? src.fade ?? 5, 0, 10),
    fadeOut: clamp(src.fadeOut ?? src.fade ?? 5, 0, 10),
    activeName: String(src.activeName || '自定义混合').slice(0, 80),
    activeId: String(src.activeId || 'custom').slice(0, 40),
    tracks
  };
}

export function sanitizePerson(person) {
  const src = person && typeof person === 'object' ? person : {};
  return {
    name: String(src.name || '听澜用户').slice(0, 20) || '听澜用户',
    tinnitus: String(src.tinnitus || '').slice(0, 60),
    sleepPreference: String(src.sleepPreference || '').slice(0, 80),
    note: String(src.note || '').slice(0, 500)
  };
}

function isoOrNull(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function sanitizeLog(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const before = Number(entry.before);
  const after = Number(entry.after);
  const date = isoOrNull(entry.date);
  if (!date || !Number.isInteger(before) || before < 0 || before > 10 || !Number.isInteger(after) || after < 0 || after > 10) return null;
  let sleep = entry.sleep === null || entry.sleep === undefined || entry.sleep === '' ? null : Number(entry.sleep);
  if (sleep !== null && (!Number.isFinite(sleep) || sleep < 0 || sleep > 600)) return null;
  let comfort = entry.comfort === null || entry.comfort === undefined || entry.comfort === '' ? null : Number(entry.comfort);
  if (comfort !== null && (!Number.isInteger(comfort) || comfort < 0 || comfort > 10)) comfort = null;
  const adverseEffects = Array.isArray(entry.adverseEffects)
    ? entry.adverseEffects.filter(item => typeof item === 'string').slice(0, 8).map(item => item.slice(0, 40))
    : [];
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 40) : '',
    date, before, after, sleep, comfort, adverseEffects,
    notes: String(entry.notes || '').slice(0, 240),
    mix: String(entry.mix || '').slice(0, 80),
    sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId.slice(0, 40) : null
  };
}

export function sanitizeSession(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const seconds = Number(entry.confirmedSeconds ?? entry.seconds);
  const date = isoOrNull(entry.date);
  if (!date || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return null;
  if (entry.endReason != null && entry.endReason !== '' && !END_REASONS.includes(entry.endReason)) return null;
  const events = Array.isArray(entry.parameterEvents) ? entry.parameterEvents.filter(event => event && typeof event.path === 'string' && Number.isFinite(+event.t)).slice(0, 400).map(event => ({
    t: Math.round(+event.t * 10) / 10,
    path: String(event.path).slice(0, 80),
    value: event.value
  })) : [];
  return {
    id: typeof entry.id === 'string' ? entry.id.slice(0, 40) : '',
    date,
    endedAt: isoOrNull(entry.endedAt),
    seconds: Math.round(seconds),
    playerSeconds: Number.isFinite(+entry.playerSeconds) ? +entry.playerSeconds : seconds,
    audioSeconds: Number.isFinite(+entry.audioSeconds) ? +entry.audioSeconds : seconds,
    confirmedSeconds: seconds,
    name: String(entry.name || '').slice(0, 80),
    tracks: typeof entry.tracks === 'string' ? entry.tracks.slice(0, 160) : '',
    presetId: typeof entry.presetId === 'string' ? entry.presetId.slice(0, 40) : '',
    initialSettings: entry.initialSettings && typeof entry.initialSettings === 'object' ? sanitizeSettings(entry.initialSettings) : null,
    parameterEvents: events,
    endReason: END_REASONS.includes(entry.endReason) ? entry.endReason : 'manual'
  };
}

export function validateBackup(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: ['备份不是 JSON 对象'] };
  if (data.version !== 4) errors.push('仅支持听澜 4.x JSON 备份');
  if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) errors.push('缺少设置');
  if (data.settings && data.settings.tracks != null && !Array.isArray(data.settings.tracks)) errors.push('音轨格式不正确');
  if (data.settings && Array.isArray(data.settings.tracks) && data.settings.tracks.length > 6) errors.push('音轨不能超过 6 条');
  if (!Array.isArray(data.logs)) errors.push('自评记录格式不正确');
  if (!Array.isArray(data.sessions)) errors.push('播放记录格式不正确');
  if (data.profiles != null && (typeof data.profiles !== 'object' || Array.isArray(data.profiles))) errors.push('个人方案格式不正确');
  if (data.favorites != null && !Array.isArray(data.favorites)) errors.push('收藏格式不正确');
  if (data.person != null && (typeof data.person !== 'object' || Array.isArray(data.person))) errors.push('档案格式不正确');
  if (Array.isArray(data.logs) && data.logs.length > 20000) errors.push('自评记录数量超出上限');
  if (Array.isArray(data.sessions) && data.sessions.length > 50000) errors.push('播放记录数量超出上限');
  if (errors.length) return { ok: false, errors };
  const logs = [];
  const sessions = [];
  let dropped = 0;
  for (const entry of data.logs) {
    const item = sanitizeLog(entry);
    if (!item) dropped++;
    else logs.push(item);
  }
  for (const entry of data.sessions) {
    const item = sanitizeSession(entry);
    if (!item) dropped++;
    else sessions.push(item);
  }
  if ((data.logs.length || data.sessions.length) && !logs.length && !sessions.length) {
    return { ok: false, errors: ['记录字段无法通过校验'] };
  }
  const profiles = {};
  if (data.profiles) {
    for (const [name, profile] of Object.entries(data.profiles).slice(0, 30)) {
      const key = String(name).slice(0, 35);
      if (!key || !profile || typeof profile !== 'object') { dropped++; continue; }
      profiles[key] = {
        name: key,
        createdAt: isoOrNull(profile.createdAt) || new Date(0).toISOString(),
        settings: sanitizeSettings(profile.settings || {})
      };
    }
  }
  return {
    ok: true,
    dropped,
    data: {
      settings: sanitizeSettings(data.settings),
      profiles,
      logs,
      sessions,
      favorites: Array.isArray(data.favorites) ? data.favorites.filter(id => typeof id === 'string').slice(0, 50).map(id => id.slice(0, 40)) : [],
      person: sanitizePerson(data.person)
    }
  };
}
