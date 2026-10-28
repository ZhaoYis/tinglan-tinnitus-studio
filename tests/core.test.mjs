import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeChannels, assessExport, boundaryStepRatio, canTransition, createClock,
  csvCell, decodedAudioAllowance, encodeWav, exportAllowance, fillNoise, masterGain, measureFilter,
  noiseLength, protectionDecision, pushParamEvent, recordsToCsv, replacementGainRatio,
  snapshotSettings, spectralSlopeDbPerOctave, trackGain, validateBackup, voiceSpec
} from '../core.js';

const SR = 44100;

test('白噪声、粉红噪声、棕色噪声的功率谱斜率接近理论值', () => {
  const expectSlope = { white: [ -1.25, 1.25 ], pink: [ -4.3, -1.7 ], brown: [ -7.6, -4.6 ] };
  for (const kind of ['white', 'pink', 'brown']) {
    const samples = fillNoise(kind, noiseLength(kind, SR), SR, 42, 0);
    const slope = spectralSlopeDbPerOctave(samples, SR);
    const [lo, hi] = expectSlope[kind];
    assert.ok(slope > lo && slope < hi, `${kind} 斜率 ${slope.toFixed(2)} dB/oct 不在 ${lo} 到 ${hi}`);
  }
});

test('循环边界的步进幅度接近信号自身的样本差', () => {
  for (const kind of ['white', 'pink', 'brown', 'rain', 'stream']) {
    const samples = fillNoise(kind, noiseLength(kind, SR), SR, 7, 1);
    const ratio = boundaryStepRatio(samples);
    assert.ok(ratio < 6, `${kind} 接缝步进比 ${ratio.toFixed(2)}`);
  }
});

test('声源替换的交叉淡化不会把两条音轨增益叠到原增益以上', () => {
  assert.ok(replacementGainRatio(0.4) <= 1);
});

test('陷波与带通在可测频段内符合中心频率和倍频程带宽', () => {
  const freqs = [1000, 2000, 4000, 4500, 6000, 8000];
  const widths = [0.2, 0.5, 1, 2, 3];
  for (const type of ['notch', 'bandpass']) {
    for (const freq of freqs) {
      for (const bw of widths) {
        const measured = measureFilter({ type, freq, bw, sampleRate: SR });
        const upper = freq * 2 ** (bw / 2);
        if (!measured.reliable) {
          assert.ok(upper >= SR * 0.2, `${type} ${freq}Hz ${bw}oct 在安全频段内却不可测`);
          continue;
        }
        assert.ok(Math.abs(Math.log2(measured.centerHz / freq)) < 0.08, `${type} 中心 ${measured.centerHz} ≠ ${freq}`);
        assert.ok(Math.abs(measured.bandwidthOct - bw) <= Math.max(0.18, bw * 0.22), `${type} 带宽 ${measured.bandwidthOct} ≠ ${bw}`);
        if (type === 'notch') assert.ok(measured.attenuationDb < -40, `陷波深度 ${measured.attenuationDb}`);
      }
    }
  }
});

test('实时与离线共用同一套音轨参数', () => {
  const track = { kind: 'notch', level: 40, pan: -20, freq: 4000, bw: 0.5, cutoff: 7000 };
  assert.deepEqual(voiceSpec(track, 2), voiceSpec(track, 2));
  const spec = voiceSpec(track, 2);
  assert.equal(spec.filter, 'notch');
  assert.equal(spec.source, 'white');
  assert.equal(spec.pan, -0.2);
  assert.ok(spec.gain > 0 && spec.gain < trackGain(40, 1));
});

test('数字增益随音量和音轨数下降，且保持有限值', () => {
  assert.ok(masterGain(0) === 0);
  assert.ok(masterGain(100) > masterGain(50));
  assert.ok(trackGain(30, 4) < trackGain(30, 1));
  assert.ok(Number.isFinite(masterGain(18)));
});

test('播放状态只接受定义好的转换', () => {
  assert.equal(canTransition('IDLE', 'STARTING'), true);
  assert.equal(canTransition('PLAYING', 'PAUSING'), true);
  assert.equal(canTransition('PAUSED', 'STARTING'), true);
  assert.equal(canTransition('PLAYING', 'PLAYING'), false);
  assert.equal(canTransition('IDLE', 'PLAYING'), false);
  assert.equal(canTransition('STOPPING', 'PLAYING'), false);
});

test('音频上下文暂停时，确认播放时长不跟随被节流的页面时钟增长', () => {
  const clock = createClock();
  clock.startPlayer(0);
  clock.noteAudio(0, true);
  assert.ok(Math.abs(clock.confirmedSeconds(2000, 2, true) - 2) < 0.02);
  clock.noteAudio(2, false);
  const confirmed = clock.confirmedSeconds(47000, 2, false);
  assert.ok(confirmed < 2.05, `后台停声后确认时长变成了 ${confirmed}`);
  assert.ok(clock.playerSeconds(47000) > 40);
});

test('音频仍在运行时，长间隔也不会把播放时长截成 30 秒', () => {
  const clock = createClock();
  clock.startPlayer(1000);
  clock.noteAudio(10, true);
  const confirmed = clock.confirmedSeconds(1000 + 45000, 55, true);
  assert.ok(confirmed > 44 && confirmed < 46, `确认时长 ${confirmed}`);
});

test('导出前拒绝削波、真峰值超限和非有限采样', () => {
  const quiet = Float32Array.from([0, 0.2, -0.2, 0.1]);
  const clipped = Float32Array.from([0.2, 1.2, -0.2, 0.1]);
  assert.equal(assessExport(analyzeChannels([quiet, quiet], SR)).ok, true);
  const clip = assessExport(analyzeChannels([clipped, clipped], SR));
  assert.equal(clip.ok, false);
  const bad = Float32Array.from([0.1, Number.NaN, 0.2, 0.1]);
  assert.equal(assessExport(analyzeChannels([bad, bad], SR)).ok, false);
});

test('WAV 头是 16-bit 立体声，且编码前的评估负责拦截削波', () => {
  const left = Float32Array.from([0, 0.5, -0.5, 0.25]);
  const right = Float32Array.from([0, -0.5, 0.5, -0.25]);
  const bytes = new Uint8Array(encodeWav(left, right, SR));
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  assert.equal(bytes[20], 1);
  assert.equal(bytes[22], 2);
});

test('低内存设备拒绝长时导出，正常设备允许 120 秒', () => {
  assert.equal(exportAllowance(120, { mobile: true }).ok, false);
  assert.equal(exportAllowance(120, { deviceMemory: 8, mobile: false }).ok, true);
  assert.equal(exportAllowance(15).ok, false);
});

test('参数快照是深拷贝，变更事件会去重', () => {
  const settings = { volume: 18, duration: 30, fadeIn: 5, fadeOut: 5, activeName: '轻柔助眠', activeId: 'sleep', tracks: [{ id: 'a', kind: 'pink', level: 20, pan: 0, freq: 4000, bw: 1, cutoff: 8000, mute: false, solo: false, fileName: '' }] };
  const shot = snapshotSettings(settings);
  settings.tracks[0].level = 90;
  settings.volume = 70;
  assert.equal(shot.tracks[0].level, 20);
  assert.equal(shot.volume, 18);
  let events = pushParamEvent([], { t: 1, path: 'volume', value: 20 });
  events = pushParamEvent(events, { t: 1.1, path: 'volume', value: 20 });
  events = pushParamEvent(events, { t: 2, path: 'volume', value: 30 });
  assert.equal(events.length, 2);
});

test('CSV 给可能被当成公式的文本加前缀，并保留数字', () => {
  assert.equal(csvCell('=cmd()', true), '"\'=cmd()"');
  assert.equal(csvCell(-3, false), '"-3"');
  const csv = recordsToCsv(
    [{ id: 's1', date: '2026-10-28T00:00:00.000Z', name: '=方案', seconds: 12, tracks: '@x', endReason: 'manual' }],
    [{ date: '2026-10-28T00:00:00.000Z', mix: '+mix', before: 5, after: 3, sleep: 20, notes: '-头痛', sessionId: 's1' }]
  );
  assert.match(csv, /'=方案/);
  assert.match(csv, /'@x/);
  assert.match(csv, /'\+mix/);
  assert.match(csv, /'-头痛/);
  assert.match(csv, /"12"/);
});

test('备份会拒绝错误版本和非法记录，并接受旧版播放日志', () => {
  const bad = validateBackup({ version: 3, settings: {}, logs: [], sessions: [] });
  assert.equal(bad.ok, false);
  const dirty = validateBackup({
    version: 4,
    settings: { volume: 10, tracks: [{ kind: 'nope', level: 999, freq: 9 }] },
    logs: [{ date: '2026-10-28T00:00:00.000Z', before: 4, after: 2, sleep: null, notes: 'ok' }, { before: 'x' }],
    sessions: [{ id: 'old', date: '2026-10-28T00:00:00.000Z', seconds: 90, name: '轻柔助眠', tracks: '粉红噪声' }],
    profiles: { 睡前: { createdAt: '2026-10-28T00:00:00.000Z', settings: { tracks: [] } } },
    favorites: ['sleep'],
    person: { name: '甲', tinnitus: '4000' }
  });
  assert.equal(dirty.ok, true);
  assert.equal(dirty.dropped, 1);
  assert.equal(dirty.data.settings.tracks[0].kind, 'pink');
  assert.equal(dirty.data.settings.tracks[0].level, 100);
  assert.equal(dirty.data.sessions[0].endReason, 'manual');
  assert.equal(dirty.data.logs[0].before, 4);
  const nested = validateBackup({ version: 4, settings: { tracks: 'no' }, logs: [], sessions: [] });
  assert.equal(nested.ok, false);
});

test('异常峰值会衰减或停止，正常峰值会消退计数', () => {
  assert.equal(protectionDecision({ peak: 0.2, safetyGain: 1, strikes: 2 }).action, 'clear');
  assert.equal(protectionDecision({ peak: 0.97, safetyGain: 1, strikes: 3 }).action, 'duck');
  assert.equal(protectionDecision({ peak: 1.2, safetyGain: 1, strikes: 0 }).action, 'stop');
  assert.equal(protectionDecision({ peak: 0.2, safetyGain: 1, strikes: 0, nonFinite: 1 }).reason, 'nonfinite');
});

test('保护压低后的增益会逐步恢复，而不是永久衰减', () => {
  let state = { safetyGain: 0.5, strikes: 4 };
  for (let i = 0; i < 60; i++) state = { ...state, ...protectionDecision({ peak: 0.2, ...state }) };
  assert.ok(state.safetyGain > 0.99, `恢复后增益仍为 ${state.safetyGain}`);
});

test('数字增益已重新定标：满档可听，且不超过数字满幅', () => {
  assert.equal(masterGain(100), 1);
  const white = fillNoise('white', noiseLength('white', 44100), 44100, 3, 0);
  let single = 0;
  for (let i = 0; i < white.length; i++) single = Math.max(single, Math.abs(white[i] * trackGain(100, 1) * masterGain(100)));
  const singleDb = 20 * Math.log10(single);
  assert.ok(singleDb > -3 && singleDb < 0, `单轨满档峰值 ${singleDb.toFixed(2)} dBFS`);

  const preset = [{ kind: 'brown', level: 32 }, { kind: 'rain', level: 31 }, { kind: 'pink', level: 20 }];
  const buffers = preset.map(t => fillNoise(t.kind, noiseLength(t.kind, 44100), 44100, 11, 0));
  let mix = 0;
  for (let i = 0; i < 44100; i++) {
    let s = 0;
    preset.forEach((t, k) => { s += buffers[k][i % buffers[k].length] * trackGain(t.level, preset.length) });
    mix = Math.max(mix, Math.abs(s * masterGain(100)));
  }
  const mixDb = 20 * Math.log10(mix);
  assert.ok(mixDb > -11 && mixDb < -8, `三轨预设满档峰值 ${mixDb.toFixed(2)} dBFS`);
  assert.ok(mixDb + 20 * Math.log10(masterGain(18)) < -25, '默认音量下输出应处在安全且可听的区间');
  assert.ok(20 * Math.log10(masterGain(18)) < -15, '默认数字增益仍保留足够衰减');
});

test('本地音频按解码后的实际内存限制，而不是只看压缩文件大小', () => {
  const long = decodedAudioAllowance({ duration: 600, sampleRate: 48000, numberOfChannels: 2 });
  assert.equal(long.ok, false);
  assert.match(long.reason, /内存/);
  assert.ok(decodedAudioAllowance({ duration: 60, sampleRate: 48000, numberOfChannels: 2 }).ok);
  assert.equal(decodedAudioAllowance({ duration: 0.1, sampleRate: 44100, numberOfChannels: 1 }).ok, false);
  assert.equal(decodedAudioAllowance({ duration: NaN, sampleRate: 44100, numberOfChannels: 1 }).ok, false);
});

test('CSV 导出包含参数快照、参数变更、舒适度与不适反应', () => {
  const csv = recordsToCsv(
    [{
      id: 's2', date: '2026-10-28T00:00:00.000Z', name: '实验', seconds: 600, confirmedSeconds: 600,
      tracks: '陷波噪声', endReason: 'completed',
      initialSettings: { volume: 30, tracks: [{ kind: 'notch', freq: 4000, bw: 0.5 }] },
      parameterEvents: [{ t: 20, path: 'track.t1.freq', value: 4200 }]
    }],
    [{ date: '2026-10-28T00:00:00.000Z', before: 6, after: 4, comfort: 7, sleep: 25, adverseEffects: ['头晕'], notes: '可耐受', sessionId: 's2' }]
  );
  assert.match(csv, /初始参数JSON/);
  assert.match(csv, /track\.t1\.freq/);
  assert.match(csv, /""freq"":4000/);
  assert.match(csv, /头晕/);
  assert.match(csv, /"舒适度"/);
});
