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

    async _extractVocals(channelData, length, sampleRate, channels, ctx) {
        const offCtx = new OfflineAudioContext(channels, length, sampleRate);
        const buffer = offCtx.createBuffer(channels, length, sampleRate);

        if (channels >= 2) {
            const left = channelData[0];
            const right = channelData[1];
            const monoCenter = new Float32Array(length);

            for (let i = 0; i < length; i++) {
                monoCenter[i] = (left[i] - right[i]) * 0.5;
            }

            const bp1 = offCtx.createBiquadFilter();
            bp1.type = 'highpass';
            bp1.frequency.value = 200;

            const bp2 = offCtx.createBiquadFilter();
            bp2.type = 'lowpass';
            bp2.frequency.value = 6000;

            const presence = offCtx.createBiquadFilter();
            presence.type = 'peaking';
            presence.frequency.value = 3000;
            presence.Q.value = 1;
            presence.gain.value = 3;

            const tempBuf = offCtx.createBuffer(1, length, sampleRate);
            tempBuf.getChannelData(0).set(monoCenter);

            const source = offCtx.createBufferSource();
            source.buffer = tempBuf;

            const merger = offCtx.createChannelMerger(channels);

            source.connect(bp1);
            bp1.connect(bp2);
            bp2.connect(presence);

            for (let ch = 0; ch < channels; ch++) {
                presence.connect(merger, 0, ch);
            }
            merger.connect(offCtx.destination);

            source.start(0);
            return await offCtx.startRendering();
        }

        const source = offCtx.createBufferSource();
        for (let ch = 0; ch < channels; ch++) {
            buffer.getChannelData(ch).set(channelData[ch]);
        }
        source.buffer = buffer;

        const bp1 = offCtx.createBiquadFilter();
        bp1.type = 'highpass';
        bp1.frequency.value = 200;

        const bp2 = offCtx.createBiquadFilter();
        bp2.type = 'lowpass';
        bp2.frequency.value = 6000;

        source.connect(bp1);
        bp1.connect(bp2);
        bp2.connect(offCtx.destination);

        source.start(0);
        return await offCtx.startRendering();
    }

    async _extractDrums(channelData, length, sampleRate, channels, ctx) {
        const offCtx = new OfflineAudioContext(channels, length, sampleRate);
        const buffer = offCtx.createBuffer(channels, length, sampleRate);

        for (let ch = 0; ch < channels; ch++) {
            buffer.getChannelData(ch).set(channelData[ch]);
        }

        const source = offCtx.createBufferSource();
        source.buffer = buffer;

        const lpf = offCtx.createBiquadFilter();
        lpf.type = 'lowpass';
        lpf.frequency.value = 200;

        const hpf = offCtx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = 4000;

        const comp = offCtx.createDynamicsCompressor();
        comp.threshold.value = -30;
        comp.ratio.value = 8;
        comp.attack.value = 0.001;
        comp.release.value = 0.05;

        const lowGain = offCtx.createGain();
        lowGain.gain.value = 0.8;
        const highGain = offCtx.createGain();
        highGain.gain.value = 0.6;
        const merger = offCtx.createGain();

        source.connect(lpf);
        lpf.connect(lowGain);
        lowGain.connect(merger);

        source.connect(hpf);
        hpf.connect(highGain);
        highGain.connect(merger);

        merger.connect(comp);
        comp.connect(offCtx.destination);

        source.start(0);
        return await offCtx.startRendering();
    }

    async _extractBass(channelData, length, sampleRate, channels, ctx) {
        const offCtx = new OfflineAudioContext(channels, length, sampleRate);
        const buffer = offCtx.createBuffer(channels, length, sampleRate);

        for (let ch = 0; ch < channels; ch++) {
            buffer.getChannelData(ch).set(channelData[ch]);
        }

        const source = offCtx.createBufferSource();
        source.buffer = buffer;

        const lpf = offCtx.createBiquadFilter();
        lpf.type = 'lowpass';
        lpf.frequency.value = 250;
        lpf.Q.value = 0.7;

        const boost = offCtx.createBiquadFilter();
        boost.type = 'peaking';
        boost.frequency.value = 80;
        boost.Q.value = 1;
        boost.gain.value = 3;

        source.connect(lpf);
        lpf.connect(boost);
        boost.connect(offCtx.destination);

        source.start(0);
        return await offCtx.startRendering();
    }

    async _extractOther(channelData, length, sampleRate, channels, ctx, existingStems) {
        const offCtx = new OfflineAudioContext(channels, length, sampleRate);
        const buffer = offCtx.createBuffer(channels, length, sampleRate);

        for (let ch = 0; ch < channels; ch++) {
            const data = new Float32Array(length);
            data.set(channelData[ch]);
            buffer.getChannelData(ch).set(data);
        }

        const source = offCtx.createBufferSource();
        source.buffer = buffer;

        const bp1 = offCtx.createBiquadFilter();
        bp1.type = 'highpass';
        bp1.frequency.value = 250;

        const bp2 = offCtx.createBiquadFilter();
        bp2.type = 'lowpass';
        bp2.frequency.value = 8000;

        const notch = offCtx.createBiquadFilter();
        notch.type = 'notch';
        notch.frequency.value = 3000;
        notch.Q.value = 0.5;

        source.connect(bp1);
        bp1.connect(bp2);
        bp2.connect(notch);
        notch.connect(offCtx.destination);

        source.start(0);
        return await offCtx.startRendering();
    }
}

window.StemSeparator = StemSeparator;
