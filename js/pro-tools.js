class ProTools {
    constructor(audioEngine) {
        this.engine = audioEngine;
    }

    // ============================================================
    // 1. 無音カット - Trim leading/trailing silence
    // ============================================================
    async trimSilence(buffer, threshold = 0.015) {
        const sr = buffer.sampleRate;
        const channels = buffer.numberOfChannels;
        const len = buffer.length;
        const windowSize = Math.floor(sr * 0.05);

        const channelData = [];
        for (let ch = 0; ch < channels; ch++) channelData.push(buffer.getChannelData(ch));

        const getRms = (start) => {
            let sum = 0, count = 0;
            for (let ch = 0; ch < channels; ch++) {
                const d = channelData[ch];
                for (let i = start; i < Math.min(start + windowSize, len); i++) {
                    sum += d[i] * d[i]; count++;
                }
            }
            return Math.sqrt(sum / Math.max(count, 1));
        };

        let startSample = 0;
        for (let i = 0; i < len; i += windowSize) {
            if (getRms(i) > threshold) { startSample = Math.max(0, i - windowSize); break; }
        }

        let endSample = len;
        for (let i = len - windowSize; i >= 0; i -= windowSize) {
            if (getRms(i) > threshold) { endSample = Math.min(len, i + windowSize * 2); break; }
        }

        const newLen = endSample - startSample;
        if (newLen <= 0 || newLen === len) return buffer;

        const out = this.engine.ctx.createBuffer(channels, newLen, sr);
        for (let ch = 0; ch < channels; ch++) {
            out.getChannelData(ch).set(channelData[ch].subarray(startSample, endSample));
        }
        return out;
    }

    // ============================================================
    // 2. アウトロフェードアウト - Smooth fade out ending
    // ============================================================
    async applyOutroFade(buffer, fadeDuration = 3.0, fadeType = 'exponential') {
        const sr = buffer.sampleRate;
        const len = buffer.length;
        const channels = buffer.numberOfChannels;
        const fadeSamples = Math.min(Math.floor(sr * fadeDuration), Math.floor(len * 0.9));
        const fadeStart = len - fadeSamples;

        const out = this.engine.ctx.createBuffer(channels, len, sr);
        const chunkSize = 44100;

        for (let ch = 0; ch < channels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = out.getChannelData(ch);
            for (let i = 0; i < fadeStart; i++) dst[i] = src[i];
            for (let i = fadeStart; i < len; i += chunkSize) {
                const end = Math.min(i + chunkSize, len);
                for (let j = i; j < end; j++) {
                    const t = (j - fadeStart) / fadeSamples;
                    let gain;
                    if (fadeType === 'exponential') gain = Math.pow(1 - t, 2.5);
                    else if (fadeType === 's-curve')  gain = 1 - (t * t * (3 - 2 * t));
                    else                               gain = 1 - t;
                    dst[j] = src[j] * Math.max(0, gain);
                }
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return out;
    }

    // ============================================================
    // 3. ボーカル加工 (ケロケロ/スムース) - Vocal character effect
    // ============================================================
    async applyAutotune(buffer, options = {}) {
        const intensity = options.intensity ?? 0.7;
        const style = options.style || 'kero';
        const sr = buffer.sampleRate;
        const len = buffer.length;
        const channels = buffer.numberOfChannels;

        const offCtx = new OfflineAudioContext(channels, len, sr);
        const buf = offCtx.createBuffer(channels, len, sr);
        for (let ch = 0; ch < channels; ch++) buf.getChannelData(ch).set(buffer.getChannelData(ch));

        const src = offCtx.createBufferSource();
        src.buffer = buf;

        if (style === 'kero') {
            // Robotic / T-Pain style: saturation + chorus stack + compression
            const ws = offCtx.createWaveShaper();
            const curve = new Float32Array(256);
            const k = 1 + intensity * 6;
            for (let i = 0; i < 256; i++) {
                const x = (i * 2) / 256 - 1;
                curve[i] = Math.tanh(x * k) / Math.tanh(k);
            }
            ws.curve = curve; ws.oversample = '4x';

            // Chorus: two detuned delays
            const d1 = offCtx.createDelay(0.1); d1.delayTime.value = 0.013;
            const d2 = offCtx.createDelay(0.1); d2.delayTime.value = 0.027;

            const gDry = offCtx.createGain(); gDry.gain.value = 1 - intensity * 0.4;
            const gW1  = offCtx.createGain(); gW1.gain.value  = intensity * 0.5;
            const gW2  = offCtx.createGain(); gW2.gain.value  = intensity * 0.35;

            const comp = offCtx.createDynamicsCompressor();
            comp.threshold.value = -18; comp.ratio.value = 10;
            comp.attack.value = 0.004; comp.release.value = 0.08;

            const presence = offCtx.createBiquadFilter();
            presence.type = 'peaking'; presence.frequency.value = 3500;
            presence.Q.value = 1.5; presence.gain.value = 4 + intensity * 3;

            const master = offCtx.createGain(); master.gain.value = 1.3;

            src.connect(ws);
            ws.connect(gDry); gDry.connect(comp);
            ws.connect(d1);   d1.connect(gW1); gW1.connect(comp);
            ws.connect(d2);   d2.connect(gW2); gW2.connect(comp);
            comp.connect(presence); presence.connect(master);
            master.connect(offCtx.destination);
        } else {
            // Smooth / natural: gentle comp + presence + air
            const comp = offCtx.createDynamicsCompressor();
            comp.threshold.value = -20; comp.ratio.value = 5;
            comp.attack.value = 0.008; comp.release.value = 0.12; comp.knee.value = 8;

            // De-esser
            const deEss = offCtx.createBiquadFilter();
            deEss.type = 'peaking'; deEss.frequency.value = 7500;
            deEss.Q.value = 2.5; deEss.gain.value = -3 - intensity * 2;

            const presence = offCtx.createBiquadFilter();
            presence.type = 'peaking'; presence.frequency.value = 3200;
            presence.Q.value = 1.2; presence.gain.value = 3 + intensity * 4;

            const air = offCtx.createBiquadFilter();
            air.type = 'highshelf'; air.frequency.value = 10000;
            air.gain.value = 2 + intensity * 3;

            const chorus = offCtx.createDelay(0.05); chorus.delayTime.value = 0.008;
            const chorusGain = offCtx.createGain(); chorusGain.gain.value = intensity * 0.25;

            const mix = offCtx.createGain(); mix.gain.value = 1.0;

            src.connect(comp); comp.connect(deEss); deEss.connect(presence);
            presence.connect(air); air.connect(mix);
            air.connect(chorus); chorus.connect(chorusGain); chorusGain.connect(mix);
            mix.connect(offCtx.destination);
        }

        src.start(0);
        return offCtx.startRendering();
    }

    // ============================================================
    // 4. J-POPボーカルコンプ - Modern J-POP vocal compression
    // ============================================================
    async applyVocalComp(buffer, preset = 'medium') {
        const presets = {
            light:  { thr: -16, ratio: 3,  atk: 0.015, rel: 0.15, knee: 10, makeup: 1.4, presence: 3 },
            medium: { thr: -22, ratio: 8,  atk: 0.007, rel: 0.09, knee: 6,  makeup: 2.0, presence: 5 },
            heavy:  { thr: -28, ratio: 16, atk: 0.003, rel: 0.055, knee: 4, makeup: 2.8, presence: 7 }
        };
        const p = presets[preset] || presets.medium;
        const sr = buffer.sampleRate;
        const len = buffer.length;
        const channels = buffer.numberOfChannels;

        const offCtx = new OfflineAudioContext(channels, len, sr);
        const buf = offCtx.createBuffer(channels, len, sr);
        for (let ch = 0; ch < channels; ch++) buf.getChannelData(ch).set(buffer.getChannelData(ch));
        const src = offCtx.createBufferSource();
        src.buffer = buf;

        const hp = offCtx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 80;

        const deEss = offCtx.createBiquadFilter();
        deEss.type = 'peaking'; deEss.frequency.value = 7200; deEss.Q.value = 2; deEss.gain.value = -4;

        const comp = offCtx.createDynamicsCompressor();
        comp.threshold.value = p.thr; comp.ratio.value = p.ratio;
        comp.attack.value = p.atk; comp.release.value = p.rel; comp.knee.value = p.knee;

        const presence = offCtx.createBiquadFilter();
        presence.type = 'peaking'; presence.frequency.value = 3200; presence.Q.value = 1.2;
        presence.gain.value = p.presence;

        const warmth = offCtx.createBiquadFilter();
        warmth.type = 'peaking'; warmth.frequency.value = 300; warmth.Q.value = 0.8;
        warmth.gain.value = 2;

        const makeup = offCtx.createGain(); makeup.gain.value = p.makeup;

        const limiter = offCtx.createDynamicsCompressor();
        limiter.threshold.value = -1; limiter.ratio.value = 20;
        limiter.attack.value = 0.001; limiter.release.value = 0.01;

        src.connect(hp); hp.connect(deEss); deEss.connect(comp);
        comp.connect(warmth); warmth.connect(presence);
        presence.connect(makeup); makeup.connect(limiter);
        limiter.connect(offCtx.destination);

        src.start(0);
        return offCtx.startRendering();
    }

    // ============================================================
    // 5. リバースシンバル/スウィープ生成
    // ============================================================
    async generateReverseCymbal(duration = 2.0) {
        const sr = this.engine.ctx.sampleRate;
        const len = Math.floor(sr * duration);
        const offCtx = new OfflineAudioContext(2, len, sr);

        const noiseBuffer = offCtx.createBuffer(1, len, sr);
        const nd = noiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;

        const noise = offCtx.createBufferSource();
        noise.buffer = noiseBuffer;

        const bp = offCtx.createBiquadFilter();
        bp.type = 'bandpass'; bp.Q.value = 1.5;
        bp.frequency.setValueAtTime(300, 0);
        bp.frequency.exponentialRampToValueAtTime(9000, duration * 0.9);

        const hpf = offCtx.createBiquadFilter();
        hpf.type = 'highpass'; hpf.frequency.value = 600;

        const env = offCtx.createGain();
        env.gain.setValueAtTime(0, 0);
        env.gain.linearRampToValueAtTime(1.0, duration * 0.8);
        env.gain.linearRampToValueAtTime(0.7, duration);

        const merger = offCtx.createChannelMerger(2);
        noise.connect(bp); bp.connect(hpf); hpf.connect(env);
        env.connect(merger, 0, 0); env.connect(merger, 0, 1);
        merger.connect(offCtx.destination);
        noise.start(0);

        const rendered = await offCtx.startRendering();

        // Reverse
        const reversed = this.engine.ctx.createBuffer(2, len, sr);
        for (let ch = 0; ch < 2; ch++) {
            const s = rendered.getChannelData(ch);
            const d = reversed.getChannelData(ch);
            for (let i = 0; i < len; i++) d[i] = s[len - 1 - i];
        }
        return reversed;
    }

    // ============================================================
    // 6. ビルドアップFX生成
    // ============================================================
    async generateBuildupFX(duration = 4.0, style = 'riser') {
        const sr = this.engine.ctx.sampleRate;
        const len = Math.floor(sr * duration);
        const offCtx = new OfflineAudioContext(2, len, sr);
        const master = offCtx.createGain();
        master.gain.setValueAtTime(0.6, 0);
        master.gain.linearRampToValueAtTime(1.0, duration * 0.9);
        master.gain.linearRampToValueAtTime(0, duration);
        master.connect(offCtx.destination);

        if (style === 'riser') {
            const osc = offCtx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(60, 0);
            osc.frequency.exponentialRampToValueAtTime(1400, duration * 0.95);

            const filt = offCtx.createBiquadFilter();
            filt.type = 'lowpass'; filt.Q.value = 3;
            filt.frequency.setValueAtTime(100, 0);
            filt.frequency.exponentialRampToValueAtTime(12000, duration * 0.95);

            const og = offCtx.createGain(); og.gain.value = 0.5;
            osc.connect(filt); filt.connect(og); og.connect(master);
            osc.start(0); osc.stop(duration);

            // Noise sweep
            const nBuf = offCtx.createBuffer(1, len, sr);
            const nd = nBuf.getChannelData(0);
            for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
            const ns = offCtx.createBufferSource(); ns.buffer = nBuf;
            const nf = offCtx.createBiquadFilter();
            nf.type = 'bandpass'; nf.Q.value = 1;
            nf.frequency.setValueAtTime(200, 0);
            nf.frequency.exponentialRampToValueAtTime(8000, duration);
            const ng = offCtx.createGain(); ng.gain.value = 0.3;
            ns.connect(nf); nf.connect(ng); ng.connect(master);
            ns.start(0);

        } else {
            // Drum roll buildup
            const numHits = Math.floor(duration * 8);
            for (let i = 0; i < numHits; i++) {
                const t = (i / numHits) * duration;
                const hitDur = Math.max(0.015, 0.12 - (i / numHits) * 0.1);
                const osc = offCtx.createOscillator();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(180 + i * 12, t);
                const hg = offCtx.createGain();
                hg.gain.setValueAtTime(0.5 + (i / numHits) * 0.4, t);
                hg.gain.exponentialRampToValueAtTime(0.001, t + hitDur);
                osc.connect(hg); hg.connect(master);
                osc.start(t); osc.stop(t + hitDur + 0.01);
            }
        }

        const rendered = await offCtx.startRendering();
        const stereo = this.engine.ctx.createBuffer(2, len, sr);
        for (let ch = 0; ch < 2; ch++) stereo.getChannelData(ch).set(rendered.getChannelData(0));
        return stereo;
    }

    // ============================================================
    // 7. 波形自動分割 - Energy-based auto-segmentation
    // ============================================================
    autoSegment(buffer, targetSegments = 4) {
        const data = buffer.getChannelData(0);
        const sr = buffer.sampleRate;
        const duration = buffer.duration;
        const windowSize = Math.floor(sr * 0.5);
        const hopSize = Math.floor(sr * 0.25);
        const len = data.length;

        const energies = [];
        for (let i = 0; i < len - windowSize; i += hopSize) {
            let sum = 0;
            for (let j = 0; j < windowSize; j++) sum += data[i + j] * data[i + j];
            energies.push({ time: i / sr, rms: Math.sqrt(sum / windowSize) });
        }

        const avg = energies.reduce((a, b) => a + b.rms, 0) / energies.length;
        const minSpacing = duration / (targetSegments + 1);

        // Find local energy minima
        const candidates = [];
        for (let i = 4; i < energies.length - 4; i++) {
            const window = energies.slice(i - 3, i + 4);
            const localMin = Math.min(...window.map(e => e.rms));
            if (energies[i].rms === localMin && energies[i].rms < avg * 0.85) {
                // Avoid segment boundaries at < 10% or > 90% of duration
                if (energies[i].time > duration * 0.1 && energies[i].time < duration * 0.9) {
                    candidates.push({ time: energies[i].time, rms: energies[i].rms });
                }
            }
        }

        candidates.sort((a, b) => a.rms - b.rms);

        const selected = [];
        for (const c of candidates) {
            if (selected.every(s => Math.abs(s.time - c.time) > minSpacing)) {
                selected.push(c);
                if (selected.length >= targetSegments - 1) break;
            }
        }
        selected.sort((a, b) => a.time - b.time);

        const segments = [];
        let prev = 0;
        for (const cut of selected) {
            segments.push({ start: prev, end: cut.time, duration: cut.time - prev });
            prev = cut.time;
        }
        segments.push({ start: prev, end: duration, duration: duration - prev });
        return segments;
    }

    // ============================================================
    // Helper: Mix FX buffer into main buffer at a time position
    // ============================================================
    async mixBufferAt(mainBuffer, fxBuffer, positionSec, fxGain = 0.75) {
        const sr = mainBuffer.sampleRate;
        const channels = mainBuffer.numberOfChannels;
        const startSample = Math.floor(positionSec * sr);
        const chunkSize = 44100;

        const out = this.engine.ctx.createBuffer(channels, mainBuffer.length, sr);
        for (let ch = 0; ch < channels; ch++) {
            const src = mainBuffer.getChannelData(ch);
            const dst = out.getChannelData(ch);
            dst.set(src);
            const fx = fxBuffer.getChannelData(Math.min(ch, fxBuffer.numberOfChannels - 1));
            for (let i = 0; i < fx.length; i += chunkSize) {
                const end = Math.min(i + chunkSize, fx.length);
                for (let j = i; j < end; j++) {
                    const idx = startSample + j;
                    if (idx < dst.length) dst[idx] = Math.max(-1, Math.min(1, dst[idx] + fx[j] * fxGain));
                }
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return out;
    }

    // ============================================================
    // 8. リファレンスマッチングEQ - Reference matching EQ
    //    プロの市販曲のスペクトルに合わせて5バンドEQ補正値を算出する
    // ============================================================

    // 軽量 radix-2 FFT（in-place, re/im は長さ2^nのFloat32Array）
    _fft(re, im) {
        const n = re.length;
        if (n <= 1) return;
        // bit-reversal permutation
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            const wRe = Math.cos(ang), wIm = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let curRe = 1, curIm = 0;
                for (let k = 0; k < len / 2; k++) {
                    const aRe = re[i + k], aIm = im[i + k];
                    const bRe = re[i + k + len / 2], bIm = im[i + k + len / 2];
                    const tRe = bRe * curRe - bIm * curIm;
                    const tIm = bRe * curIm + bIm * curRe;
                    re[i + k] = aRe + tRe; im[i + k] = aIm + tIm;
                    re[i + k + len / 2] = aRe - tRe; im[i + k + len / 2] = aIm - tIm;
                    const nRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = nRe;
                }
            }
        }
    }

    // バッファの平均スペクトルを5バンド(dB)に集約して返す
    // bands: { low, lowmid, mid, highmid, high } 各dB(相対)
    analyzeSpectrumBands(buffer) {
        const data = buffer.getChannelData(0);
        const sr = buffer.sampleRate;
        const N = 4096;                       // FFTサイズ
        const hann = new Float32Array(N);
        for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));

        // 重い処理を避けるため最大120フレームに間引いてサンプリング
        const maxFrames = 120;
        const totalFrames = Math.max(1, Math.floor(data.length / N));
        const stride = Math.max(1, Math.floor(totalFrames / maxFrames));
        const mag = new Float32Array(N / 2);
        let frameCount = 0;

        for (let f = 0; f < totalFrames; f += stride) {
            const start = f * N;
            if (start + N > data.length) break;
            const re = new Float32Array(N);
            const im = new Float32Array(N);
            for (let i = 0; i < N; i++) re[i] = data[start + i] * hann[i];
            this._fft(re, im);
            for (let i = 0; i < N / 2; i++) {
                mag[i] += Math.sqrt(re[i] * re[i] + im[i] * im[i]);
            }
            frameCount++;
        }
        if (frameCount === 0) return { low: 0, lowmid: 0, mid: 0, highmid: 0, high: 0 };
        for (let i = 0; i < mag.length; i++) mag[i] /= frameCount;

        // 周波数バンド定義（マスターEQのバンドに対応）
        const bandRanges = {
            low:    [20, 160],
            lowmid: [160, 700],
            mid:    [700, 2500],
            highmid:[2500, 7000],
            high:   [7000, sr / 2]
        };
        const binHz = sr / N;
        const result = {};
        for (const [name, [lo, hi]] of Object.entries(bandRanges)) {
            const loBin = Math.max(1, Math.floor(lo / binHz));
            const hiBin = Math.min(mag.length - 1, Math.ceil(hi / binHz));
            let sum = 0, cnt = 0;
            for (let i = loBin; i <= hiBin; i++) { sum += mag[i] * mag[i]; cnt++; }
            const rms = Math.sqrt(sum / Math.max(cnt, 1));
            result[name] = 20 * Math.log10(rms + 1e-9); // dB
        }
        return result;
    }

    // リファレンス曲のスペクトルにターゲットを近づけるEQ補正値を算出
    // 戻り値: { low, lowmid, mid, highmid, high } 各dB(-maxBoost～+maxBoost)
    computeMatchingEQ(refBuffer, targetBuffer, maxBoost = 6) {
        const ref = this.analyzeSpectrumBands(refBuffer);
        const tgt = this.analyzeSpectrumBands(targetBuffer);
        const bands = ['low', 'lowmid', 'mid', 'highmid', 'high'];

        // 各バンドの差分(dB) = リファレンス - ターゲット
        const diffs = {};
        bands.forEach(b => { diffs[b] = ref[b] - tgt[b]; });

        // 全体音量差を除去して「音色バランス」だけを抽出（平均を引く）
        const avg = bands.reduce((a, b) => a + diffs[b], 0) / bands.length;
        const eq = {};
        bands.forEach(b => {
            let v = diffs[b] - avg;
            v = Math.max(-maxBoost, Math.min(maxBoost, v)); // クランプ
            eq[b] = Math.round(v * 10) / 10;
        });
        return eq;
    }

    // ============================================================
    // Helper: Extract a sub-buffer (for segmentation)
    // ============================================================
    extractSegment(buffer, startSec, endSec) {
        const sr = buffer.sampleRate;
        const channels = buffer.numberOfChannels;
        const startSample = Math.floor(startSec * sr);
        const endSample = Math.min(Math.floor(endSec * sr), buffer.length);
        const len = endSample - startSample;
        if (len <= 0) return null;
        const out = this.engine.ctx.createBuffer(channels, len, sr);
        for (let ch = 0; ch < channels; ch++) {
            out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(startSample, endSample));
        }
        return out;
    }
}

window.ProTools = ProTools;
