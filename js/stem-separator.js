class StemSeparator {
    constructor(audioEngine) {
        this.engine = audioEngine;
    }

    async separate(buffer, options = {}) {
        const stems = {};
        const ctx = this.engine.ctx;
        const sampleRate = buffer.sampleRate;
        const length = buffer.length;
        const duration = buffer.duration;
        const channels = buffer.numberOfChannels;

        const onProgress = options.onProgress || (() => {});

        onProgress(0, '分析中...');

        const fftSize = 4096;
        const hopSize = fftSize / 4;
        const numFrames = Math.ceil(length / hopSize);

        const channelData = [];
        for (let ch = 0; ch < channels; ch++) {
            channelData.push(buffer.getChannelData(ch));
        }

        onProgress(10, 'ボーカルを分離中...');

        if (options.vocals !== false) {
            stems.vocals = await this._extractVocals(channelData, length, sampleRate, channels, ctx);
        }

        onProgress(35, 'ドラムを分離中...');

        if (options.drums !== false) {
            stems.drums = await this._extractDrums(channelData, length, sampleRate, channels, ctx);
        }

        onProgress(60, 'ベースを分離中...');

        if (options.bass !== false) {
            stems.bass = await this._extractBass(channelData, length, sampleRate, channels, ctx);
        }

        onProgress(80, 'その他を分離中...');

        if (options.other !== false) {
            stems.other = await this._extractOther(channelData, length, sampleRate, channels, ctx, stems);
        }

        onProgress(100, '完了');

        return stems;
    }

    // ヘルパー: OfflineContextで音源+フィルタチェーンを描画
    async _render(channelData, length, sampleRate, channels, buildGraph) {
        const offCtx = new OfflineAudioContext(channels, length, sampleRate);
        const buf = offCtx.createBuffer(channels, length, sampleRate);
        for (let ch = 0; ch < channels; ch++) buf.getChannelData(ch).set(channelData[ch]);
        const src = offCtx.createBufferSource();
        src.buffer = buf;
        buildGraph(offCtx, src, offCtx.destination);
        src.start(0);
        return offCtx.startRendering();
    }

    // ヘルパー: ピーク正規化（非同期・メインスレッドをブロックしない）
    async _normalizeBuffer(buffer) {
        const chunkSize = 44100;
        let peak = 0;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const d = buffer.getChannelData(ch);
            for (let i = 0; i < d.length; i += chunkSize) {
                const end = Math.min(i + chunkSize, d.length);
                for (let j = i; j < end; j++) peak = Math.max(peak, Math.abs(d[j]));
                await new Promise(r => setTimeout(r, 0));
            }
        }
        if (peak < 0.01) return buffer;
        const gain = 0.85 / peak;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const d = buffer.getChannelData(ch);
            for (let i = 0; i < d.length; i += chunkSize) {
                const end = Math.min(i + chunkSize, d.length);
                for (let j = i; j < end; j++) d[j] *= gain;
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return buffer;
    }

    /**
     * ボーカル: ステレオ差分（センター成分を除いた残り）+ Mid強調
     * ボーカルはセンター定位なので L-R を反転すると残る成分が楽器系になり、
     * L+R のセンター成分にバンドパスをかけてボーカル帯域だけを抽出する
     */
    async _extractVocals(channelData, length, sampleRate, channels, ctx) {
        const offCtx = new OfflineAudioContext(channels, length, sampleRate);
        const outBuf = offCtx.createBuffer(channels, length, sampleRate);

        if (channels >= 2) {
            const L = channelData[0], R = channelData[1];
            // Mid = (L+R)/2 → ボーカルを含むセンター成分
            const midData = new Float32Array(length);
            for (let i = 0; i < length; i++) midData[i] = (L[i] + R[i]) * 0.5;

            const midBuf = offCtx.createBuffer(1, length, sampleRate);
            midBuf.getChannelData(0).set(midData);

            const src = offCtx.createBufferSource();
            src.buffer = midBuf;

            // 200Hz–6kHz バンドパス（ボーカル帯域）
            const hp = offCtx.createBiquadFilter();
            hp.type = 'highpass'; hp.frequency.value = 200; hp.Q.value = 0.7;

            const lp = offCtx.createBiquadFilter();
            lp.type = 'lowpass'; lp.frequency.value = 5500; lp.Q.value = 0.7;

            // 3kHz プレゼンス強調（明瞭度向上）
            const presence = offCtx.createBiquadFilter();
            presence.type = 'peaking';
            presence.frequency.value = 3000; presence.Q.value = 1.5; presence.gain.value = 5;

            const merger = offCtx.createChannelMerger(channels);
            src.connect(hp); hp.connect(lp); lp.connect(presence);
            for (let ch = 0; ch < channels; ch++) presence.connect(merger, 0, ch);
            merger.connect(offCtx.destination);
            src.start(0);
        } else {
            // モノラル: そのままバンドパス
            const buf = offCtx.createBuffer(1, length, sampleRate);
            buf.getChannelData(0).set(channelData[0]);
            const src = offCtx.createBufferSource();
            src.buffer = buf;
            const hp = offCtx.createBiquadFilter();
            hp.type = 'highpass'; hp.frequency.value = 200;
            const lp = offCtx.createBiquadFilter();
            lp.type = 'lowpass'; lp.frequency.value = 5500;
            src.connect(hp); hp.connect(lp); lp.connect(offCtx.destination);
            src.start(0);
        }
        return await this._normalizeBuffer(await offCtx.startRendering());
    }

    /**
     * ドラム: トランジェント検出ベース + 低域キック + 高域ハット
     * エネルギーの急峻な変化部分（オンセット）を強調することで打楽器成分を抽出
     */
    async _extractDrums(channelData, length, sampleRate, channels, ctx) {
        const offCtx = new OfflineAudioContext(channels, length, sampleRate);
        const buf = offCtx.createBuffer(channels, length, sampleRate);

        // ドラムの特徴: キック(60-120Hz) + スネア(200-400Hz) + ハット(8k-16kHz)
        // + トランジェント強調のため強めのコンプレッション
        for (let ch = 0; ch < channels; ch++) buf.getChannelData(ch).set(channelData[ch]);

        const src = offCtx.createBufferSource();
        src.buffer = buf;

        // キック成分（低域）
        const kickLP = offCtx.createBiquadFilter();
        kickLP.type = 'lowpass'; kickLP.frequency.value = 150; kickLP.Q.value = 0.5;
        const kickBoost = offCtx.createBiquadFilter();
        kickBoost.type = 'peaking'; kickBoost.frequency.value = 80; kickBoost.Q.value = 1; kickBoost.gain.value = 8;
        const kickGain = offCtx.createGain();
        kickGain.gain.value = 1.2;

        // スネア/打楽器成分（中低域）
        const snareHP = offCtx.createBiquadFilter();
        snareHP.type = 'highpass'; snareHP.frequency.value = 150;
        const snareLP = offCtx.createBiquadFilter();
        snareLP.type = 'lowpass'; snareLP.frequency.value = 500;
        const snareGain = offCtx.createGain();
        snareGain.gain.value = 0.7;

        // ハット成分（高域）
        const hatHP = offCtx.createBiquadFilter();
        hatHP.type = 'highpass'; hatHP.frequency.value = 7000; hatHP.Q.value = 0.5;
        const hatGain = offCtx.createGain();
        hatGain.gain.value = 0.5;

        // トランジェント強調コンプ
        const comp = offCtx.createDynamicsCompressor();
        comp.threshold.value = -35; comp.ratio.value = 12;
        comp.attack.value = 0.001; comp.release.value = 0.05;

        const mix = offCtx.createGain();

        src.connect(kickLP); kickLP.connect(kickBoost); kickBoost.connect(kickGain); kickGain.connect(mix);
        src.connect(snareHP); snareHP.connect(snareLP); snareLP.connect(snareGain); snareGain.connect(mix);
        src.connect(hatHP); hatHP.connect(hatGain); hatGain.connect(mix);
        mix.connect(comp); comp.connect(offCtx.destination);

        src.start(0);
        return await this._normalizeBuffer(await offCtx.startRendering());
    }

    /**
     * ベース: 低域のみ（300Hz以下）を明確に抽出
     * ベース音域の基音とハーモニクスを含む鋭いフィルタ
     */
    async _extractBass(channelData, length, sampleRate, channels, ctx) {
        return this._render(channelData, length, sampleRate, channels, (offCtx, src, dest) => {
            const lp1 = offCtx.createBiquadFilter();
            lp1.type = 'lowpass'; lp1.frequency.value = 300; lp1.Q.value = 0.5;

            const lp2 = offCtx.createBiquadFilter();
            lp2.type = 'lowpass'; lp2.frequency.value = 300; lp2.Q.value = 0.5;

            const boost = offCtx.createBiquadFilter();
            boost.type = 'peaking'; boost.frequency.value = 90; boost.Q.value = 1.5; boost.gain.value = 6;

            const hp = offCtx.createBiquadFilter();
            hp.type = 'highpass'; hp.frequency.value = 35; // DCカット

            const gain = offCtx.createGain();
            gain.gain.value = 1.3;

            src.connect(hp); hp.connect(lp1); lp1.connect(lp2); lp2.connect(boost); boost.connect(gain); gain.connect(dest);
        }).then(b => this._normalizeBuffer(b));
    }

    /**
     * その他（ギター・シンセ・ピアノ等）: 中高域メイン
     * ボーカル帯域とドラム帯域を除いた残差に近い成分を抽出
     */
    async _extractOther(channelData, length, sampleRate, channels, ctx, existingStems) {
        return this._render(channelData, length, sampleRate, channels, (offCtx, src, dest) => {
            // ベース・ドラム低域を除いた中高域
            const hp = offCtx.createBiquadFilter();
            hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = 0.7;

            const lp = offCtx.createBiquadFilter();
            lp.type = 'lowpass'; lp.frequency.value = 9000; lp.Q.value = 0.7;

            // ボーカル帯域（3kHz）をノッチで少し抑制
            const notch = offCtx.createBiquadFilter();
            notch.type = 'notch'; notch.frequency.value = 3000; notch.Q.value = 2;

            // 中域ブースト（メロディ楽器を前に出す）
            const midBoost = offCtx.createBiquadFilter();
            midBoost.type = 'peaking'; midBoost.frequency.value = 800; midBoost.Q.value = 0.8; midBoost.gain.value = 4;

            src.connect(hp); hp.connect(lp); lp.connect(notch); notch.connect(midBoost); midBoost.connect(dest);
        }).then(b => this._normalizeBuffer(b));
    }
}

window.StemSeparator = StemSeparator;
