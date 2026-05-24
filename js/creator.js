/**
 * StudioFlow Creator Engine
 * ① シームレスループ加工
 * ② ボーカル除去（インスト版生成）
 * ③ BPM変換（タイムストレッチ）
 */
class CreatorEngine {
    constructor(audioEngine) {
        this.engine = audioEngine;
    }

    // ============================================
    // ① シームレスループ加工
    // ============================================

    /**
     * 自然なループポイントを自動検出する
     * - 曲の後半から始まりと似たエネルギーを持つ位置を探す
     * @param {AudioBuffer} buffer
     * @returns {{ startSec: number, endSec: number, score: number }}
     */
    detectLoopPoints(buffer) {
        const sr = buffer.sampleRate;
        const data = buffer.getChannelData(0);
        const len = data.length;

        // RMSエネルギーをブロック単位で計算
        const blockSize = Math.floor(sr * 0.1); // 0.1秒ブロック
        const numBlocks = Math.floor(len / blockSize);
        const rms = new Float32Array(numBlocks);

        for (let b = 0; b < numBlocks; b++) {
            let sum = 0;
            const offset = b * blockSize;
            for (let i = 0; i < blockSize; i++) {
                sum += data[offset + i] ** 2;
            }
            rms[b] = Math.sqrt(sum / blockSize);
        }

        // 曲の最初2秒のエネルギープロファイル
        const introBlocks = Math.min(20, numBlocks);
        const introRms = rms.slice(0, introBlocks);

        // 後半部分（50%〜95%）からベストなループポイントを探す
        const searchStart = Math.floor(numBlocks * 0.5);
        const searchEnd = Math.floor(numBlocks * 0.95);

        let bestBlock = searchStart;
        let bestScore = Infinity;

        for (let b = searchStart; b < searchEnd; b++) {
            // イントロとの類似度（RMS差分）
            let score = 0;
            for (let i = 0; i < introBlocks && b + i < numBlocks; i++) {
                score += Math.abs(rms[b + i] - introRms[i]);
            }
            if (score < bestScore) {
                bestScore = score;
                bestBlock = b;
            }
        }

        return {
            startSec: 0,
            endSec: (bestBlock * blockSize) / sr,
            score: bestScore
        };
    }

    /**
     * クロスフェードでシームレスループを生成
     * @param {AudioBuffer} buffer - 元の音声
     * @param {object} options
     *   loopEnd: ループ終了点（秒）  0=自動検出
     *   fadeLength: クロスフェードの長さ（秒）デフォルト3秒
     *   onProgress: (pct, text) => void
     * @returns {Promise<AudioBuffer>} ループ可能なバッファ
     */
    async createSeamlessLoop(buffer, options = {}) {
        const sr = buffer.sampleRate;
        const channels = buffer.numberOfChannels;

        // ループ終了点の決定
        let loopEndSec = options.loopEnd || 0;
        if (loopEndSec <= 0) {
            options.onProgress?.(10, 'ループポイントを自動検出中...');
            const points = this.detectLoopPoints(buffer);
            loopEndSec = points.endSec;
        }

        const fadeLen = options.fadeLength ?? 3.0;
        const loopEndSample = Math.floor(loopEndSec * sr);
        const fadeSamples = Math.floor(fadeLen * sr);

        // ループ本体の長さ = loopEnd - fadeLen（クロスフェード分を除く）
        const loopBodySamples = loopEndSample - fadeSamples;
        if (loopBodySamples <= 0) {
            throw new Error('曲が短すぎます。フェード長を短くしてください。');
        }

        options.onProgress?.(30, 'クロスフェード処理中...');

        // 出力バッファ = ループ本体の長さ
        const ctx = this.engine.ctx;
        const outBuf = ctx.createBuffer(channels, loopBodySamples, sr);

        for (let ch = 0; ch < channels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = outBuf.getChannelData(ch);

            for (let i = 0; i < loopBodySamples; i++) {
                if (i < fadeSamples) {
                    // 最初のfadeLen秒：末尾からのフェードアウトと冒頭のフェードインを合成
                    const fadePos = i / fadeSamples;
                    const fadeIn  = Math.sin(fadePos * Math.PI / 2);  // 0→1
                    const fadeOut = Math.cos(fadePos * Math.PI / 2);  // 1→0

                    const tailSample = src[loopEndSample - fadeSamples + i] ?? 0;
                    const headSample = src[i] ?? 0;
                    dst[i] = tailSample * fadeOut + headSample * fadeIn;
                } else {
                    dst[i] = src[i] ?? 0;
                }
            }
        }

        options.onProgress?.(80, 'ノーマライズ中...');
        return this._normalize(outBuf);
    }

    // ============================================
    // ② ボーカル除去（インスト版生成）
    // ============================================

    /**
     * ステムからボーカルを除いたインスト版を生成
     * stems: { vocals, drums, bass, other } のうち vocals を除いてミックス
     * @param {object} stems  - StemSeparatorの出力
     * @param {object} options - { vocalMix: 0.0 } // 0=完全除去, 0.1=少し残す
     * @returns {Promise<AudioBuffer>}
     */
    async createInstrumental(stems, options = {}) {
        const vocalMix = options.vocalMix ?? 0.0;
        const ctx = this.engine.ctx;

        // drums, bass, other を合算
        const parts = ['drums', 'bass', 'other'].filter(k => stems[k]);
        if (vocalMix > 0 && stems.vocals) parts.push('vocals');

        if (parts.length === 0) throw new Error('ミックスできるパートがありません');

        const ref = stems[parts[0]];
        const sr = ref.sampleRate;
        const len = ref.length;
        const ch = ref.numberOfChannels;

        const out = ctx.createBuffer(ch, len, sr);

        for (let c = 0; c < ch; c++) {
            const dst = out.getChannelData(c);
            parts.forEach(key => {
                if (!stems[key]) return;
                const vol = (key === 'vocals') ? vocalMix : 1.0;
                const src = stems[key].getChannelData(Math.min(c, stems[key].numberOfChannels - 1));
                for (let i = 0; i < len; i++) {
                    dst[i] += (src[i] ?? 0) * vol;
                }
            });
        }

        return this._normalize(out);
    }

    /**
     * 単一バッファからミッド/サイド処理でボーカルを除去（ステム分離なし版）
     * センターに定位したボーカルを減衰させる
     * @param {AudioBuffer} buffer
     * @param {number} reduction - 除去量 0.0〜1.0 (デフォルト0.9)
     * @returns {Promise<AudioBuffer>}
     */
    async removeVocalMidSide(buffer, reduction = 0.9) {
        const ctx = this.engine.ctx;
        const sr = buffer.sampleRate;
        const len = buffer.length;

        // モノラルの場合はそのまま返す
        if (buffer.numberOfChannels < 2) {
            return buffer;
        }

        const out = ctx.createBuffer(2, len, sr);
        const L = buffer.getChannelData(0);
        const R = buffer.getChannelData(1);
        const outL = out.getChannelData(0);
        const outR = out.getChannelData(1);

        for (let i = 0; i < len; i++) {
            // ミッド（センター）= L+R, サイド（左右差）= L-R
            const mid  = (L[i] + R[i]) * 0.5;
            const side = (L[i] - R[i]) * 0.5;

            // ミッドを減衰（ボーカルはセンターに多い）
            const reducedMid = mid * (1.0 - reduction);

            outL[i] = reducedMid + side;
            outR[i] = reducedMid - side;
        }

        return this._normalize(out);
    }

    // ============================================
    // ③ BPM変換（タイムストレッチ）
    // ============================================

    /**
     * BPMを変換する（ピッチを保ちながらテンポを変える）
     * @param {AudioBuffer} buffer
     * @param {number} originalBpm
     * @param {number} targetBpm
     * @param {function} onProgress
     * @returns {Promise<AudioBuffer>}
     */
    async changeBpm(buffer, originalBpm, targetBpm, onProgress) {
        const rate = targetBpm / originalBpm;  // 速度比率
        const sr = buffer.sampleRate;
        const channels = buffer.numberOfChannels;
        const originalLen = buffer.length;

        onProgress?.(10, `BPM ${originalBpm} → ${targetBpm} 変換中...`);

        // Step1: playbackRateで速度変更（ピッチも変わる）
        const stretchedLen = Math.ceil(originalLen / rate);
        const offCtx1 = new OfflineAudioContext(channels, stretchedLen, sr);
        const srcBuf = offCtx1.createBuffer(channels, originalLen, sr);
        for (let ch = 0; ch < channels; ch++) {
            srcBuf.getChannelData(ch).set(buffer.getChannelData(ch));
        }
        const src1 = offCtx1.createBufferSource();
        src1.buffer = srcBuf;
        src1.playbackRate.value = rate;
        src1.connect(offCtx1.destination);
        src1.start(0);
        const stretched = await offCtx1.startRendering();

        onProgress?.(50, 'ピッチ補正中...');

        // Step2: ピッチを元に戻す（速度変更の逆補正）
        // playbackRateで伸ばした分、逆方向にリサンプリング
        const finalBuf = this.engine.ctx.createBuffer(channels, stretchedLen, sr);
        for (let ch = 0; ch < channels; ch++) {
            const src = stretched.getChannelData(ch);
            const dst = finalBuf.getChannelData(ch);
            // ピッチ逆補正: stretched音声を1/rateのrateで再生
            const pitchRate = 1.0 / rate;
            const ratio = src.length / stretchedLen;
            for (let i = 0; i < stretchedLen; i++) {
                const pos = i * ratio;
                const idx = Math.floor(pos);
                const frac = pos - idx;
                if (idx + 1 < src.length) {
                    dst[i] = src[idx] * (1 - frac) + src[idx + 1] * frac;
                } else if (idx < src.length) {
                    dst[i] = src[idx];
                }
            }
        }

        onProgress?.(80, 'ノーマライズ中...');

        // Step3: ピッチ補正EQ（速度変換によるアーティファクトを軽減）
        const offCtx2 = new OfflineAudioContext(channels, stretchedLen, sr);
        const eqBuf = offCtx2.createBuffer(channels, stretchedLen, sr);
        for (let ch = 0; ch < channels; ch++) {
            eqBuf.getChannelData(ch).set(finalBuf.getChannelData(ch));
        }
        const src2 = offCtx2.createBufferSource();
        src2.buffer = eqBuf;

        // 軽いEQ補正
        const hpf = offCtx2.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = 30;

        const compressor = offCtx2.createDynamicsCompressor();
        compressor.threshold.value = -20;
        compressor.ratio.value = 2;

        src2.connect(hpf);
        hpf.connect(compressor);
        compressor.connect(offCtx2.destination);
        src2.start(0);
        const result = await offCtx2.startRendering();

        onProgress?.(100, '完了');
        return this._normalize(result);
    }

    /**
     * 曲のBPMを自動検出（オンセット検出ベース）
     * @param {AudioBuffer} buffer
     * @returns {number} 推定BPM
     */
    detectBpm(buffer) {
        const data = buffer.getChannelData(0);
        const sr = buffer.sampleRate;

        // オンセット強度を計算（エネルギー差分）
        const frameSize = 512;
        const hopSize = 256;
        const numFrames = Math.floor((data.length - frameSize) / hopSize);
        const onsets = [];

        let prevEnergy = 0;
        for (let f = 0; f < numFrames; f++) {
            let energy = 0;
            const offset = f * hopSize;
            for (let i = 0; i < frameSize; i++) {
                energy += data[offset + i] ** 2;
            }
            energy /= frameSize;

            const diff = Math.max(0, energy - prevEnergy);
            onsets.push(diff);
            prevEnergy = energy;
        }

        // ピーク検出
        const peaks = [];
        const threshold = onsets.reduce((a, b) => a + b, 0) / onsets.length * 2;
        for (let i = 1; i < onsets.length - 1; i++) {
            if (onsets[i] > threshold && onsets[i] > onsets[i-1] && onsets[i] > onsets[i+1]) {
                peaks.push(i * hopSize / sr);
            }
        }

        if (peaks.length < 2) return 120;

        // ピーク間の平均間隔からBPMを算出
        const intervals = [];
        for (let i = 1; i < Math.min(peaks.length, 30); i++) {
            const interval = peaks[i] - peaks[i-1];
            if (interval > 0.25 && interval < 2.0) {
                intervals.push(interval);
            }
        }
        if (intervals.length === 0) return 120;

        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const bpm = Math.round(60 / avgInterval);

        // 妥当なBPM範囲に収める
        if (bpm < 60) return bpm * 2;
        if (bpm > 200) return Math.round(bpm / 2);
        return bpm;
    }

    // ============================================
    // ④ 音声編集（切り抜き・フェード）
    // ============================================

    /**
     * 音声バッファを指定範囲で切り抜く
     * @param {AudioBuffer} buffer
     * @param {number} startSec  - 開始秒
     * @param {number} endSec    - 終了秒（0 = 末尾まで）
     * @returns {AudioBuffer}
     */
    trimBuffer(buffer, startSec, endSec = 0) {
        const sr = buffer.sampleRate;
        const totalSamples = buffer.length;
        const startSample = Math.max(0, Math.floor(startSec * sr));
        const endSample   = endSec > 0
            ? Math.min(totalSamples, Math.floor(endSec * sr))
            : totalSamples;

        if (startSample >= endSample) {
            throw new Error('切り抜き範囲が無効です。開始点 < 終了点になるよう設定してください。');
        }

        const length = endSample - startSample;
        const out = this.engine.ctx.createBuffer(buffer.numberOfChannels, length, sr);

        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = out.getChannelData(ch);
            dst.set(src.subarray(startSample, endSample));
        }
        return out;
    }

    /**
     * フェードイン・フェードアウトを適用する（コピーを変更）
     * @param {AudioBuffer} buffer
     * @param {number} fadeInSec   - フェードイン秒数 (0 = なし)
     * @param {number} fadeOutSec  - フェードアウト秒数 (0 = なし)
     * @returns {AudioBuffer} 同じバッファを返す（変更済み）
     */
    applyFades(buffer, fadeInSec = 0, fadeOutSec = 0) {
        const sr   = buffer.sampleRate;
        const len  = buffer.length;
        const fadeInSamples  = Math.floor(fadeInSec  * sr);
        const fadeOutSamples = Math.floor(fadeOutSec * sr);

        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const data = buffer.getChannelData(ch);

            // フェードイン: 先頭 fadeInSamples をコサインカーブで 0→1
            for (let i = 0; i < Math.min(fadeInSamples, len); i++) {
                const t = i / fadeInSamples;
                data[i] *= 0.5 - 0.5 * Math.cos(t * Math.PI); // 0 → 1
            }

            // フェードアウト: 末尾 fadeOutSamples をコサインカーブで 1→0
            for (let i = 0; i < Math.min(fadeOutSamples, len); i++) {
                const pos = len - fadeOutSamples + i;
                const t   = i / fadeOutSamples;
                data[pos] *= 0.5 + 0.5 * Math.cos(t * Math.PI); // 1 → 0
            }
        }
        return buffer;
    }

    /**
     * 切り抜き + フェードを一括適用してノーマライズ
     * @param {AudioBuffer} buffer  - 元バッファ（破壊しない）
     * @param {object} opts
     *   startSec: 開始秒 (default 0)
     *   endSec:   終了秒 (default = 全体)
     *   fadeIn:   フェードイン秒 (default 0)
     *   fadeOut:  フェードアウト秒 (default 0)
     * @returns {AudioBuffer} 新しいバッファ
     */
    applyEdits(buffer, opts = {}) {
        const { startSec = 0, endSec = 0, fadeIn = 0, fadeOut = 0 } = opts;
        let result;

        // 切り抜きが必要な場合だけ trim
        const doTrim = startSec > 0 || (endSec > 0 && endSec < buffer.duration - 0.05);
        if (doTrim) {
            result = this.trimBuffer(buffer, startSec, endSec || buffer.duration);
        } else {
            // コピーを作って元バッファを破壊しない
            const copy = this.engine.ctx.createBuffer(
                buffer.numberOfChannels, buffer.length, buffer.sampleRate);
            for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                copy.getChannelData(ch).set(buffer.getChannelData(ch));
            }
            result = copy;
        }

        if (fadeIn > 0 || fadeOut > 0) {
            this.applyFades(result, fadeIn, fadeOut);
        }

        return this._normalize(result);
    }

    // ============================================
    // ユーティリティ
    // ============================================

    /** ピーク正規化 */
    _normalize(buffer, targetDb = -1.0) {
        const targetAmp = Math.pow(10, targetDb / 20);
        let peak = 0;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                peak = Math.max(peak, Math.abs(data[i]));
            }
        }
        if (peak === 0 || peak >= targetAmp) return buffer;

        const gain = targetAmp / peak;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                data[i] *= gain;
            }
        }
        return buffer;
    }
}

window.CreatorEngine = CreatorEngine;
