class RemixEngine {
    constructor(audioEngine) {
        this.engine = audioEngine;
        this.songs = [];
        this.sequence = [];
        this.crossfadeDuration = 3.0;
        this.crossfadeType = 'equal-power';
        this.colors = [
            '#e94560', '#0ea5e9', '#22c55e', '#eab308',
            '#a855f7', '#f97316', '#06b6d4', '#ec4899'
        ];
    }

    addSong(name, buffer) {
        const id = 'song_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const song = {
            id,
            name,
            buffer,
            duration: buffer.duration,
            color: this.colors[this.songs.length % this.colors.length],
            startTrim: 0,
            endTrim: buffer.duration
        };
        this.songs.push(song);
        this.sequence.push({ songId: id, startTrim: 0, endTrim: buffer.duration });
        return song;
    }

    removeSong(songId) {
        this.songs = this.songs.filter(s => s.id !== songId);
        this.sequence = this.sequence.filter(s => s.songId !== songId);
    }

    addToSequence(songId) {
        const song = this.songs.find(s => s.id === songId);
        if (song) {
            this.sequence.push({
                songId,
                startTrim: song.startTrim || 0,
                endTrim: song.endTrim || song.duration
            });
        }
    }

    removeFromSequence(index) {
        this.sequence.splice(index, 1);
    }

    moveInSequence(fromIndex, toIndex) {
        const item = this.sequence.splice(fromIndex, 1)[0];
        this.sequence.splice(toIndex, 0, item);
    }

    getSong(songId) {
        return this.songs.find(s => s.id === songId);
    }

    async renderMix() {
        if (this.sequence.length === 0) return null;

        const ctx = this.engine.ctx;
        const sampleRate = ctx.sampleRate;

        let totalDuration = 0;
        const segmentDurations = this.sequence.map(seg => {
            const song = this.getSong(seg.songId);
            return (seg.endTrim || song.duration) - (seg.startTrim || 0);
        });

        for (let i = 0; i < segmentDurations.length; i++) {
            totalDuration += segmentDurations[i];
            if (i > 0) {
                totalDuration -= this.crossfadeDuration;
            }
        }
        totalDuration = Math.max(totalDuration, 1);

        const offCtx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
        let currentTime = 0;

        for (let i = 0; i < this.sequence.length; i++) {
            const seg = this.sequence[i];
            const song = this.getSong(seg.songId);
            if (!song) continue;

            const segStart = seg.startTrim || 0;
            const segEnd = seg.endTrim || song.duration;
            const segDuration = segEnd - segStart;

            const source = offCtx.createBufferSource();
            source.buffer = song.buffer;

            const gainNode = offCtx.createGain();
            source.connect(gainNode);
            gainNode.connect(offCtx.destination);

            if (i > 0 && this.crossfadeDuration > 0) {
                const fadeStart = currentTime;
                const fadeEnd = currentTime + this.crossfadeDuration;
                this._applyCrossfadeIn(gainNode, fadeStart, fadeEnd, offCtx);
            } else {
                gainNode.gain.setValueAtTime(1, currentTime);
            }

            if (i < this.sequence.length - 1 && this.crossfadeDuration > 0) {
                const fadeOutStart = currentTime + segDuration - this.crossfadeDuration;
                const fadeOutEnd = currentTime + segDuration;
                this._applyCrossfadeOut(gainNode, fadeOutStart, fadeOutEnd, offCtx);
            }

            source.start(currentTime, segStart, segDuration);

            currentTime += segDuration;
            if (i < this.sequence.length - 1) {
                currentTime -= this.crossfadeDuration;
            }
        }

        return await offCtx.startRendering();
    }

    _applyCrossfadeIn(gainNode, startTime, endTime, ctx) {
        const duration = endTime - startTime;

        switch (this.crossfadeType) {
            case 'linear':
                gainNode.gain.setValueAtTime(0, startTime);
                gainNode.gain.linearRampToValueAtTime(1, endTime);
                break;

            case 'equal-power':
                const stepsIn = 20;
                for (let i = 0; i <= stepsIn; i++) {
                    const t = startTime + (i / stepsIn) * duration;
                    const value = Math.cos((1 - i / stepsIn) * 0.5 * Math.PI);
                    gainNode.gain.setValueAtTime(value, t);
                }
                break;

            case 's-curve':
                const stepsS = 20;
                for (let i = 0; i <= stepsS; i++) {
                    const t = startTime + (i / stepsS) * duration;
                    const x = i / stepsS;
                    const value = x * x * (3 - 2 * x);
                    gainNode.gain.setValueAtTime(value, t);
                }
                break;

            case 'exponential':
                gainNode.gain.setValueAtTime(0.001, startTime);
                gainNode.gain.exponentialRampToValueAtTime(1, endTime);
                break;
        }
    }

    _applyCrossfadeOut(gainNode, startTime, endTime, ctx) {
        const duration = endTime - startTime;

        switch (this.crossfadeType) {
            case 'linear':
                gainNode.gain.setValueAtTime(1, startTime);
                gainNode.gain.linearRampToValueAtTime(0, endTime);
                break;

            case 'equal-power':
                const stepsIn = 20;
                for (let i = 0; i <= stepsIn; i++) {
                    const t = startTime + (i / stepsIn) * duration;
                    const value = Math.cos((i / stepsIn) * 0.5 * Math.PI);
                    gainNode.gain.setValueAtTime(value, t);
                }
                break;

            case 's-curve':
                const stepsS = 20;
                for (let i = 0; i <= stepsS; i++) {
                    const t = startTime + (i / stepsS) * duration;
                    const x = i / stepsS;
                    const value = 1 - x * x * (3 - 2 * x);
                    gainNode.gain.setValueAtTime(value, t);
                }
                break;

            case 'exponential':
                gainNode.gain.setValueAtTime(1, startTime);
                gainNode.gain.exponentialRampToValueAtTime(0.001, endTime);
                break;
        }
    }

    async autoMix() {
        if (this.songs.length < 2) return null;

        const analyses = this.songs.map(song => ({
            song,
            bpm: this._estimateBPM(song.buffer),
            energy: this._analyzeEnergy(song.buffer)
        }));

        analyses.sort((a, b) => a.energy - b.energy);

        this.sequence = [];
        analyses.forEach(a => {
            this.sequence.push({
                songId: a.song.id,
                startTrim: a.song.startTrim || 0,
                endTrim: a.song.endTrim || a.song.duration
            });
        });

        return this.renderMix();
    }

    _estimateBPM(buffer) {
        const data = buffer.getChannelData(0);
        const sampleRate = buffer.sampleRate;
        const windowSize = 1024;
        const hopSize = 512;

        const energies = [];
        for (let i = 0; i < data.length - windowSize; i += hopSize) {
            let energy = 0;
            for (let j = 0; j < windowSize; j++) {
                energy += data[i + j] * data[i + j];
            }
            energies.push(energy / windowSize);
        }

        let onsetCount = 0;
        const threshold = 1.5;
        for (let i = 1; i < energies.length; i++) {
            if (energies[i] > energies[i - 1] * threshold) {
                onsetCount++;
            }
        }

        const durationSec = data.length / sampleRate;
        const bpm = (onsetCount / durationSec) * 60;

        return Math.max(60, Math.min(200, Math.round(bpm)));
    }

    _analyzeEnergy(buffer) {
        const data = buffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum += data[i] * data[i];
        }
        return Math.sqrt(sum / data.length);
    }
}

window.RemixEngine = RemixEngine;
