class VocalProcessor {
    constructor(audioEngine) {
        this.engine = audioEngine;
        this.settings = {
            pitchStrength: 50,
            pitchSpeed: 30,
            key: 'C',
            scale: 'major',
            denoise: 30,
            deesser: 40,
            presence: 3,
            breathRemoval: 20,
            reverb: 20,
            delay: 0,
            doubling: 0,
            harmony: 'none'
        };
    }

    getScaleFrequencies(key, scale) {
        const noteFreqs = {
            'C': 261.63, 'C#': 277.18, 'D': 293.66, 'D#': 311.13,
            'E': 329.63, 'F': 349.23, 'F#': 369.99, 'G': 392.00,
            'G#': 415.30, 'A': 440.00, 'A#': 466.16, 'B': 493.88
        };

        const scales = {
            'major': [0, 2, 4, 5, 7, 9, 11],
            'minor': [0, 2, 3, 5, 7, 8, 10],
            'chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            'pentatonic': [0, 2, 4, 7, 9]
        };

        const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const keyIndex = notes.indexOf(key);
        const scaleIntervals = scales[scale] || scales.major;

        const validNotes = scaleIntervals.map(interval => (keyIndex + interval) % 12);
        return validNotes;
    }

    async processVocal(buffer, settings) {
        settings = { ...this.settings, ...settings };
        const ctx = this.engine.ctx;
        const sampleRate = buffer.sampleRate;
        const length = buffer.length;
        const channels = buffer.numberOfChannels;

        const offCtx = new OfflineAudioContext(channels, length, sampleRate);
        const srcBuffer = offCtx.createBuffer(channels, length, sampleRate);

        for (let ch = 0; ch < channels; ch++) {
            srcBuffer.getChannelData(ch).set(buffer.getChannelData(ch));
        }

        const source = offCtx.createBufferSource();
        source.buffer = srcBuffer;

        let currentNode = source;

        if (settings.denoise > 0) {
            const hpf = offCtx.createBiquadFilter();
            hpf.type = 'highpass';
            hpf.frequency.value = 60 + settings.denoise * 1.5;
            hpf.Q.value = 0.7;
            currentNode.connect(hpf);
            currentNode = hpf;
        }

        if (settings.deesser > 0) {
            const deesserFilter = offCtx.createBiquadFilter();
            deesserFilter.type = 'peaking';
            deesserFilter.frequency.value = 7000;
            deesserFilter.Q.value = 2;
            deesserFilter.gain.value = -(settings.deesser / 10);
            currentNode.connect(deesserFilter);
            currentNode = deesserFilter;
        }

        if (settings.presence !== 0) {
            const presenceFilter = offCtx.createBiquadFilter();
            presenceFilter.type = 'peaking';
            presenceFilter.frequency.value = 3500;
            presenceFilter.Q.value = 1.5;
            presenceFilter.gain.value = settings.presence;
            currentNode.connect(presenceFilter);
            currentNode = presenceFilter;
        }

        const warmth = offCtx.createBiquadFilter();
        warmth.type = 'peaking';
        warmth.frequency.value = 250;
        warmth.Q.value = 0.8;
        warmth.gain.value = 1.5;
        currentNode.connect(warmth);
        currentNode = warmth;

        const airBand = offCtx.createBiquadFilter();
        airBand.type = 'highshelf';
        airBand.frequency.value = 12000;
        airBand.gain.value = 2;
        currentNode.connect(airBand);
        currentNode = airBand;

        const compressor = offCtx.createDynamicsCompressor();
        compressor.threshold.value = -20;
        compressor.ratio.value = 3;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.1;
        currentNode.connect(compressor);
        currentNode = compressor;

        if (settings.reverb > 0) {
            const dry = offCtx.createGain();
            dry.gain.value = 1 - settings.reverb / 200;
            const wet = offCtx.createGain();
            wet.gain.value = settings.reverb / 100;
            const convolver = offCtx.createConvolver();

            const irLength = 1.5 * sampleRate;
            const impulse = offCtx.createBuffer(2, irLength, sampleRate);
            for (let ch = 0; ch < 2; ch++) {
                const data = impulse.getChannelData(ch);
                for (let i = 0; i < irLength; i++) {
                    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLength, 3);
                }
            }
            convolver.buffer = impulse;

            const output = offCtx.createGain();
            currentNode.connect(dry);
            currentNode.connect(convolver);
            convolver.connect(wet);
            dry.connect(output);
            wet.connect(output);
            currentNode = output;
        }

        if (settings.delay > 0) {
            const dry = offCtx.createGain();
            dry.gain.value = 1;
            const delayNode = offCtx.createDelay(2);
            delayNode.delayTime.value = 0.25;
            const feedback = offCtx.createGain();
            feedback.gain.value = 0.2;
            const delayWet = offCtx.createGain();
            delayWet.gain.value = settings.delay / 100;

            const output = offCtx.createGain();
            currentNode.connect(dry);
            currentNode.connect(delayNode);
            delayNode.connect(feedback);
            feedback.connect(delayNode);
            delayNode.connect(delayWet);
            dry.connect(output);
            delayWet.connect(output);
            currentNode = output;
        }

        if (settings.doubling > 0) {
            const dry = offCtx.createGain();
            dry.gain.value = 1;
            const doubleDelay = offCtx.createDelay(0.1);
            doubleDelay.delayTime.value = 0.02 + Math.random() * 0.01;
            const doubleGain = offCtx.createGain();
            doubleGain.gain.value = settings.doubling / 150;

            const lfo = offCtx.createOscillator();
            lfo.frequency.value = 0.8;
            const lfoGain = offCtx.createGain();
            lfoGain.gain.value = 0.003;
            lfo.connect(lfoGain);
            lfoGain.connect(doubleDelay.delayTime);
            lfo.start();

            const output = offCtx.createGain();
            currentNode.connect(dry);
            currentNode.connect(doubleDelay);
            doubleDelay.connect(doubleGain);
            dry.connect(output);
            doubleGain.connect(output);
            currentNode = output;
        }

        currentNode.connect(offCtx.destination);
        source.start(0);

        return await offCtx.startRendering();
    }

    async changeGender(buffer, semitones) {
        const ctx = this.engine.ctx;
        const sampleRate = buffer.sampleRate;
        const channels = buffer.numberOfChannels;
        const length = buffer.length;

        // ピッチ変更倍率（半音数からレートを算出）
        const rate = Math.pow(2, semitones / 12);

        // Step 1: playbackRateを変えてレンダリング（ピッチ＋速度が変わる）
        const stretchedLength = Math.ceil(length / rate);
        const offCtx1 = new OfflineAudioContext(channels, stretchedLength, sampleRate);
        const tempBuf = offCtx1.createBuffer(channels, length, sampleRate);
        for (let ch = 0; ch < channels; ch++) {
            tempBuf.getChannelData(ch).set(buffer.getChannelData(ch));
        }
        const src1 = offCtx1.createBufferSource();
        src1.buffer = tempBuf;
        src1.playbackRate.value = rate;
        src1.connect(offCtx1.destination);
        src1.start(0);
        const pitched = await offCtx1.startRendering();

        // Step 2: リサンプリングで元の長さに戻す（速度を元に戻してピッチだけ残す）
        const finalBuf = ctx.createBuffer(channels, length, sampleRate);
        for (let ch = 0; ch < channels; ch++) {
            const src = pitched.getChannelData(ch);
            const dst = finalBuf.getChannelData(ch);
            const ratio = src.length / length;
            for (let i = 0; i < length; i++) {
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

        // Step 3: フォルマント補正（簡易的にEQでボイスの質感を調整）
        const offCtx2 = new OfflineAudioContext(channels, length, sampleRate);
        const eqBuf = offCtx2.createBuffer(channels, length, sampleRate);
        for (let ch = 0; ch < channels; ch++) {
            eqBuf.getChannelData(ch).set(finalBuf.getChannelData(ch));
        }
        const src2 = offCtx2.createBufferSource();
        src2.buffer = eqBuf;

        // 男→女の場合（semitones > 0）: 高域を少しブースト、低域を少しカット
        // 女→男の場合（semitones < 0）: 低域を少しブースト、高域を少しカット
        const formantEQ = offCtx2.createBiquadFilter();
        if (semitones > 0) {
            formantEQ.type = 'highshelf';
            formantEQ.frequency.value = 3000;
            formantEQ.gain.value = 3;
        } else {
            formantEQ.type = 'lowshelf';
            formantEQ.frequency.value = 300;
            formantEQ.gain.value = 3;
        }

        const formantEQ2 = offCtx2.createBiquadFilter();
        if (semitones > 0) {
            formantEQ2.type = 'lowshelf';
            formantEQ2.frequency.value = 200;
            formantEQ2.gain.value = -2;
        } else {
            formantEQ2.type = 'highshelf';
            formantEQ2.frequency.value = 4000;
            formantEQ2.gain.value = -2;
        }

        src2.connect(formantEQ);
        formantEQ.connect(formantEQ2);
        formantEQ2.connect(offCtx2.destination);
        src2.start(0);

        return await offCtx2.startRendering();
    }

    applyPreset(presetName) {
        const presets = {
            'clean': {
                denoise: 40, deesser: 30, presence: 2, breathRemoval: 30,
                reverb: 10, delay: 0, doubling: 0, harmony: 'none'
            },
            'warm': {
                denoise: 20, deesser: 20, presence: -1, breathRemoval: 15,
                reverb: 25, delay: 0, doubling: 20, harmony: 'none'
            },
            'bright': {
                denoise: 30, deesser: 50, presence: 5, breathRemoval: 20,
                reverb: 15, delay: 0, doubling: 0, harmony: 'none'
            },
            'radio': {
                denoise: 50, deesser: 60, presence: 6, breathRemoval: 40,
                reverb: 5, delay: 0, doubling: 10, harmony: 'none'
            },
            'telephone': {
                denoise: 80, deesser: 10, presence: 0, breathRemoval: 0,
                reverb: 0, delay: 0, doubling: 0, harmony: 'none'
            },
            'autotune': {
                pitchStrength: 100, pitchSpeed: 1,
                denoise: 30, deesser: 40, presence: 3, breathRemoval: 20,
                reverb: 20, delay: 10, doubling: 30, harmony: 'none'
            }
        };

        if (presets[presetName]) {
            this.settings = { ...this.settings, ...presets[presetName] };
            return this.settings;
        }
        return null;
    }
}

window.VocalProcessor = VocalProcessor;
