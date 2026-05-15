class MasteringEngine {
    constructor(audioEngine) {
        this.engine = audioEngine;
        this.presets = {
            pop: { low: 2, lowmid: -1, mid: 1, highmid: 2, high: 3, threshold: -18, ratio: 3, attack: 10, release: 200, ceiling: -0.3, gain: 3, width: 110 },
            rock: { low: 3, lowmid: 1, mid: 0, highmid: 2, high: 1, threshold: -20, ratio: 4, attack: 5, release: 150, ceiling: -0.3, gain: 4, width: 105 },
            hiphop: { low: 5, lowmid: 2, mid: -1, highmid: 1, high: 2, threshold: -16, ratio: 5, attack: 8, release: 180, ceiling: -0.3, gain: 5, width: 120 },
            edm: { low: 4, lowmid: 0, mid: -2, highmid: 3, high: 4, threshold: -14, ratio: 6, attack: 3, release: 100, ceiling: -0.1, gain: 6, width: 130 },
            jazz: { low: 1, lowmid: 0, mid: 0, highmid: 1, high: 1, threshold: -28, ratio: 2, attack: 20, release: 300, ceiling: -1, gain: 1, width: 100 },
            classical: { low: 0, lowmid: 0, mid: 0, highmid: 0.5, high: 0.5, threshold: -30, ratio: 1.5, attack: 30, release: 500, ceiling: -1, gain: 0, width: 100 },
            podcast: { low: -2, lowmid: 1, mid: 2, highmid: 3, high: 1, threshold: -20, ratio: 4, attack: 5, release: 150, ceiling: -0.5, gain: 4, width: 80 },
            loudness: { low: 2, lowmid: 1, mid: 1, highmid: 2, high: 2, threshold: -12, ratio: 8, attack: 2, release: 80, ceiling: -0.1, gain: 8, width: 100 }
        };
    }

    applyPreset(name) {
        const preset = this.presets[name];
        if (!preset) return null;

        this.engine.setMasterEQ('low', preset.low);
        this.engine.setMasterEQ('lowmid', preset.lowmid);
        this.engine.setMasterEQ('mid', preset.mid);
        this.engine.setMasterEQ('highmid', preset.highmid);
        this.engine.setMasterEQ('high', preset.high);

        this.engine.setMasterCompressor('threshold', preset.threshold);
        this.engine.setMasterCompressor('ratio', preset.ratio);
        this.engine.setMasterCompressor('attack', preset.attack);
        this.engine.setMasterCompressor('release', preset.release);

        this.engine.setMasterLimiter('ceiling', preset.ceiling);
        this.engine.setMasterLimiter('gain', preset.gain);

        return preset;
    }

    getPresetValues(name) {
        return this.presets[name] || null;
    }

    analyzeLoudness(buffer) {
        const data = buffer.getChannelData(0);
        let sumSquares = 0;
        let peak = 0;

        for (let i = 0; i < data.length; i++) {
            const abs = Math.abs(data[i]);
            sumSquares += data[i] * data[i];
            if (abs > peak) peak = abs;
        }

        const rms = Math.sqrt(sumSquares / data.length);
        const lufs = 20 * Math.log10(rms) - 0.691;
        const peakDb = 20 * Math.log10(peak);
        const crestFactor = peakDb - (20 * Math.log10(rms));

        return {
            lufs: Math.round(lufs * 10) / 10,
            peak: Math.round(peakDb * 10) / 10,
            rms: Math.round(20 * Math.log10(rms) * 10) / 10,
            crestFactor: Math.round(crestFactor * 10) / 10,
            dynamicRange: Math.round(crestFactor * 10) / 10
        };
    }

    async normalizeBuffer(buffer, targetDb = -0.3) {
        const ctx = this.engine.ctx;
        const channels = buffer.numberOfChannels;
        const length = buffer.length;
        const sampleRate = buffer.sampleRate;

        let peak = 0;
        for (let ch = 0; ch < channels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                const abs = Math.abs(data[i]);
                if (abs > peak) peak = abs;
            }
        }

        const targetLinear = Math.pow(10, targetDb / 20);
        const gain = targetLinear / peak;

        const newBuffer = ctx.createBuffer(channels, length, sampleRate);
        for (let ch = 0; ch < channels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = newBuffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                dst[i] = Math.max(-1, Math.min(1, src[i] * gain));
            }
        }

        return newBuffer;
    }
}

window.MasteringEngine = MasteringEngine;
