class EffectsProcessor {
    constructor(audioEngine) {
        this.engine = audioEngine;
        this.effectChains = new Map();
    }

    createEffect(type, ctx) {
        ctx = ctx || this.engine.ctx;
        switch (type) {
            case 'eq': return this._createEQ(ctx);
            case 'compressor': return this._createCompressor(ctx);
            case 'reverb': return this._createReverb(ctx);
            case 'delay': return this._createDelay(ctx);
            case 'chorus': return this._createChorus(ctx);
            case 'distortion': return this._createDistortion(ctx);
            case 'filter': return this._createFilter(ctx);
            case 'gate': return this._createGate(ctx);
            case 'phaser': return this._createPhaser(ctx);
            case 'stereo-enhancer': return this._createStereoEnhancer(ctx);
            case 'pitch-shift': return this._createPitchShift(ctx);
            case 'tape-saturation': return this._createTapeSaturation(ctx);
            default: return null;
        }
    }

    _createEQ(ctx) {
        const low = ctx.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = 200;
        low.gain.value = 0;

        const mid = ctx.createBiquadFilter();
        mid.type = 'peaking';
        mid.frequency.value = 1000;
        mid.Q.value = 1;
        mid.gain.value = 0;

        const high = ctx.createBiquadFilter();
        high.type = 'highshelf';
        high.frequency.value = 5000;
        high.gain.value = 0;

        low.connect(mid);
        mid.connect(high);

        return {
            type: 'eq',
            name: 'イコライザー',
            input: low,
            output: high,
            params: { low, mid, high },
            controls: [
                { name: 'Low', param: 'low', prop: 'gain', min: -12, max: 12, value: 0, unit: 'dB' },
                { name: 'Mid', param: 'mid', prop: 'gain', min: -12, max: 12, value: 0, unit: 'dB' },
                { name: 'High', param: 'high', prop: 'gain', min: -12, max: 12, value: 0, unit: 'dB' },
                { name: 'Mid Freq', param: 'mid', prop: 'frequency', min: 200, max: 8000, value: 1000, unit: 'Hz' }
            ]
        };
    }

    _createCompressor(ctx) {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -24;
        comp.ratio.value = 4;
        comp.attack.value = 0.003;
        comp.release.value = 0.25;

        return {
            type: 'compressor',
            name: 'コンプレッサー',
            input: comp,
            output: comp,
            params: { comp },
            controls: [
                { name: 'スレッショルド', param: 'comp', prop: 'threshold', min: -60, max: 0, value: -24, unit: 'dB' },
                { name: 'レシオ', param: 'comp', prop: 'ratio', min: 1, max: 20, value: 4, unit: ':1' },
                { name: 'アタック', param: 'comp', prop: 'attack', min: 0, max: 0.1, value: 0.003, unit: 's' },
                { name: 'リリース', param: 'comp', prop: 'release', min: 0.01, max: 1, value: 0.25, unit: 's' }
            ]
        };
    }

    _createReverb(ctx) {
        const convolver = ctx.createConvolver();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const input = ctx.createGain();
        const output = ctx.createGain();

        dry.gain.value = 0.7;
        wet.gain.value = 0.3;

        const length = 2 * ctx.sampleRate;
        const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
            const data = impulse.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
            }
        }
        convolver.buffer = impulse;

        input.connect(dry);
        input.connect(convolver);
        convolver.connect(wet);
        dry.connect(output);
        wet.connect(output);

        return {
            type: 'reverb',
            name: 'リバーブ',
            input,
            output,
            params: { dry, wet },
            controls: [
                { name: 'ドライ', param: 'dry', prop: 'gain', min: 0, max: 1, value: 0.7, unit: '' },
                { name: 'ウェット', param: 'wet', prop: 'gain', min: 0, max: 1, value: 0.3, unit: '' }
            ]
        };
    }

    _createDelay(ctx) {
        const delay = ctx.createDelay(5.0);
        delay.delayTime.value = 0.3;
        const feedback = ctx.createGain();
        feedback.gain.value = 0.3;
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        wet.gain.value = 0.3;
        const input = ctx.createGain();
        const output = ctx.createGain();

        input.connect(dry);
        input.connect(delay);
        delay.connect(feedback);
        feedback.connect(delay);
        delay.connect(wet);
        dry.connect(output);
        wet.connect(output);

        return {
            type: 'delay',
            name: 'ディレイ',
            input,
            output,
            params: { delay, feedback, wet },
            controls: [
                { name: 'タイム', param: 'delay', prop: 'delayTime', min: 0.01, max: 2, value: 0.3, unit: 's' },
                { name: 'フィードバック', param: 'feedback', prop: 'gain', min: 0, max: 0.9, value: 0.3, unit: '' },
                { name: 'ミックス', param: 'wet', prop: 'gain', min: 0, max: 1, value: 0.3, unit: '' }
            ]
        };
    }

    _createChorus(ctx) {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dry = ctx.createGain();
        const wet = ctx.createGain();
        wet.gain.value = 0.5;
        const delay = ctx.createDelay();
        delay.delayTime.value = 0.025;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 1.5;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.005;
        lfo.connect(lfoGain);
        lfoGain.connect(delay.delayTime);
        lfo.start();

        input.connect(dry);
        input.connect(delay);
        delay.connect(wet);
        dry.connect(output);
        wet.connect(output);

        return {
            type: 'chorus',
            name: 'コーラス',
            input,
            output,
            params: { lfo, lfoGain, wet },
            controls: [
                { name: 'レート', param: 'lfo', prop: 'frequency', min: 0.1, max: 10, value: 1.5, unit: 'Hz' },
                { name: '深さ', param: 'lfoGain', prop: 'gain', min: 0, max: 0.02, value: 0.005, unit: '' },
                { name: 'ミックス', param: 'wet', prop: 'gain', min: 0, max: 1, value: 0.5, unit: '' }
            ]
        };
    }

    _createDistortion(ctx) {
        const waveshaper = ctx.createWaveShaper();
        const input = ctx.createGain();
        const output = ctx.createGain();
        output.gain.value = 0.5;

        function makeDistortionCurve(amount) {
            const k = amount;
            const samples = 44100;
            const curve = new Float32Array(samples);
            const deg = Math.PI / 180;
            for (let i = 0; i < samples; i++) {
                const x = (i * 2) / samples - 1;
                curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
            }
            return curve;
        }

        waveshaper.curve = makeDistortionCurve(50);
        waveshaper.oversample = '4x';

        input.connect(waveshaper);
        waveshaper.connect(output);

        return {
            type: 'distortion',
            name: 'ディストーション',
            input,
            output,
            params: { waveshaper, output },
            _makeDistortionCurve: makeDistortionCurve,
            controls: [
                { name: 'ドライブ', param: '_drive', min: 0, max: 100, value: 50, unit: '' },
                { name: '出力', param: 'output', prop: 'gain', min: 0, max: 1, value: 0.5, unit: '' }
            ]
        };
    }

    _createFilter(ctx) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 5000;
        filter.Q.value = 1;

        return {
            type: 'filter',
            name: 'フィルター',
            input: filter,
            output: filter,
            params: { filter },
            controls: [
                { name: '周波数', param: 'filter', prop: 'frequency', min: 20, max: 20000, value: 5000, unit: 'Hz' },
                { name: 'Q', param: 'filter', prop: 'Q', min: 0.1, max: 20, value: 1, unit: '' }
            ]
        };
    }

    _createGate(ctx) {
        const input = ctx.createGain();
        const output = ctx.createGain();
        input.connect(output);

        return {
            type: 'gate',
            name: 'ゲート',
            input,
            output,
            params: { output },
            controls: [
                { name: 'スレッショルド', param: '_threshold', min: -80, max: 0, value: -40, unit: 'dB' }
            ]
        };
    }

    _createPhaser(ctx) {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const allpass = ctx.createBiquadFilter();
        allpass.type = 'allpass';
        allpass.frequency.value = 1000;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.5;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 500;
        lfo.connect(lfoGain);
        lfoGain.connect(allpass.frequency);
        lfo.start();

        input.connect(allpass);
        input.connect(output);
        allpass.connect(output);

        return {
            type: 'phaser',
            name: 'フェイザー',
            input,
            output,
            params: { lfo, lfoGain },
            controls: [
                { name: 'レート', param: 'lfo', prop: 'frequency', min: 0.1, max: 8, value: 0.5, unit: 'Hz' },
                { name: '深さ', param: 'lfoGain', prop: 'gain', min: 100, max: 5000, value: 500, unit: '' }
            ]
        };
    }

    _createStereoEnhancer(ctx) {
        const input = ctx.createGain();
        const output = ctx.createGain();
        input.connect(output);

        return {
            type: 'stereo-enhancer',
            name: 'ステレオエンハンサー',
            input,
            output,
            params: {},
            controls: [
                { name: '幅', param: '_width', min: 0, max: 200, value: 100, unit: '%' }
            ]
        };
    }

    _createPitchShift(ctx) {
        const input = ctx.createGain();
        const output = ctx.createGain();
        input.connect(output);

        return {
            type: 'pitch-shift',
            name: 'ピッチシフト',
            input,
            output,
            params: {},
            controls: [
                { name: '半音', param: '_semitones', min: -12, max: 12, value: 0, unit: 'st' }
            ]
        };
    }

    _createTapeSaturation(ctx) {
        const waveshaper = ctx.createWaveShaper();
        const input = ctx.createGain();
        const output = ctx.createGain();

        const samples = 44100;
        const curve = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
            const x = (i * 2) / samples - 1;
            curve[i] = Math.tanh(x * 2) * 0.8;
        }
        waveshaper.curve = curve;
        waveshaper.oversample = '4x';

        const lpf = ctx.createBiquadFilter();
        lpf.type = 'lowpass';
        lpf.frequency.value = 12000;

        input.connect(waveshaper);
        waveshaper.connect(lpf);
        lpf.connect(output);

        return {
            type: 'tape-saturation',
            name: 'テープサチュレーション',
            input,
            output,
            params: { lpf },
            controls: [
                { name: 'ドライブ', param: '_drive', min: 0, max: 100, value: 30, unit: '%' },
                { name: 'トーン', param: 'lpf', prop: 'frequency', min: 2000, max: 18000, value: 12000, unit: 'Hz' }
            ]
        };
    }

    addEffectToTrack(trackId, effectType) {
        if (!this.effectChains.has(trackId)) {
            this.effectChains.set(trackId, []);
        }
        const effect = this.createEffect(effectType);
        if (effect) {
            this.effectChains.get(trackId).push(effect);
        }
        return effect;
    }

    removeEffectFromTrack(trackId, index) {
        const chain = this.effectChains.get(trackId);
        if (chain && chain[index]) {
            chain.splice(index, 1);
        }
    }

    getTrackEffects(trackId) {
        return this.effectChains.get(trackId) || [];
    }

    connectEffectChain(trackId, inputNode, outputNode) {
        const chain = this.effectChains.get(trackId) || [];
        if (chain.length === 0) {
            inputNode.connect(outputNode);
            return;
        }

        inputNode.connect(chain[0].input);
        for (let i = 0; i < chain.length - 1; i++) {
            chain[i].output.connect(chain[i + 1].input);
        }
        chain[chain.length - 1].output.connect(outputNode);
    }
}

window.EffectsProcessor = EffectsProcessor;
