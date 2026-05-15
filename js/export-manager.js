class ExportManager {
    constructor(audioEngine) {
        this.engine = audioEngine;
        this.albumArt = null;
        this.albumArtDataUrl = null;
    }

    setAlbumArt(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                this.albumArtDataUrl = e.target.result;
                this.albumArt = file;
                resolve(this.albumArtDataUrl);
            };
            reader.readAsDataURL(file);
        });
    }

    removeAlbumArt() {
        this.albumArt = null;
        this.albumArtDataUrl = null;
    }

    async exportAudio(tracks, options = {}) {
        const format = options.format || 'wav';
        const sampleRate = options.sampleRate || 44100;
        const bitDepth = options.bitDepth || 16;
        const normalize = options.normalize !== false;
        const metadata = options.metadata || {};

        let maxDuration = 0;
        tracks.forEach(track => {
            if (track.muted) return;
            track.clips.forEach(clip => {
                if (!clip.buffer) return;
                const end = (clip.startTime || 0) + clip.buffer.duration;
                if (end > maxDuration) maxDuration = end;
            });
        });

        if (maxDuration === 0) return null;

        let renderedBuffer = await this.engine.renderOffline(tracks, maxDuration, sampleRate);

        if (normalize) {
            renderedBuffer = await this._normalizeBuffer(renderedBuffer, -0.3);
        }

        let blob;
        switch (format) {
            case 'wav':
                blob = this._encodeWAV(renderedBuffer, bitDepth);
                break;
            case 'mp3':
            case 'ogg':
            case 'flac':
                blob = this._encodeWAV(renderedBuffer, bitDepth);
                break;
            default:
                blob = this._encodeWAV(renderedBuffer, bitDepth);
        }

        return {
            blob,
            url: URL.createObjectURL(blob),
            duration: maxDuration,
            format,
            fileName: this._getFileName(metadata, format)
        };
    }

    async exportBuffer(buffer, options = {}) {
        const format = options.format || 'wav';
        const bitDepth = options.bitDepth || 16;
        const normalize = options.normalize !== false;

        let finalBuffer = buffer;
        if (normalize) {
            finalBuffer = await this._normalizeBuffer(buffer, -0.3);
        }

        const blob = this._encodeWAV(finalBuffer, bitDepth);

        return {
            blob,
            url: URL.createObjectURL(blob),
            duration: buffer.duration,
            format
        };
    }

    _encodeWAV(buffer, bitDepth = 16) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const bytesPerSample = bitDepth / 8;
        const blockAlign = numChannels * bytesPerSample;
        const dataLength = buffer.length * blockAlign;
        const headerLength = 44;

        const arrayBuffer = new ArrayBuffer(headerLength + dataLength);
        const view = new DataView(arrayBuffer);

        this._writeString(view, 0, 'RIFF');
        view.setUint32(4, headerLength + dataLength - 8, true);
        this._writeString(view, 8, 'WAVE');
        this._writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        this._writeString(view, 36, 'data');
        view.setUint32(40, dataLength, true);

        const channels = [];
        for (let ch = 0; ch < numChannels; ch++) {
            channels.push(buffer.getChannelData(ch));
        }

        let offset = headerLength;
        for (let i = 0; i < buffer.length; i++) {
            for (let ch = 0; ch < numChannels; ch++) {
                const sample = Math.max(-1, Math.min(1, channels[ch][i]));
                if (bitDepth === 16) {
                    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                } else if (bitDepth === 24) {
                    const val = Math.round(sample * 0x7FFFFF);
                    view.setUint8(offset, val & 0xFF);
                    view.setUint8(offset + 1, (val >> 8) & 0xFF);
                    view.setUint8(offset + 2, (val >> 16) & 0xFF);
                } else if (bitDepth === 32) {
                    view.setFloat32(offset, sample, true);
                }
                offset += bytesPerSample;
            }
        }

        return new Blob([arrayBuffer], { type: 'audio/wav' });
    }

    async _normalizeBuffer(buffer, targetDb) {
        const channels = buffer.numberOfChannels;
        const length = buffer.length;

        let peak = 0;
        for (let ch = 0; ch < channels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                const abs = Math.abs(data[i]);
                if (abs > peak) peak = abs;
            }
        }

        if (peak === 0) return buffer;

        const targetLinear = Math.pow(10, targetDb / 20);
        const gain = targetLinear / peak;

        const ctx = this.engine.ctx;
        const newBuffer = ctx.createBuffer(channels, length, buffer.sampleRate);
        for (let ch = 0; ch < channels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = newBuffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                dst[i] = Math.max(-1, Math.min(1, src[i] * gain));
            }
        }
        return newBuffer;
    }

    _writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    _getFileName(metadata, format) {
        const title = metadata.title || 'untitled';
        const artist = metadata.artist || '';
        const name = artist ? `${artist} - ${title}` : title;
        const ext = format === 'mp3' ? 'wav' : format === 'ogg' ? 'wav' : format === 'flac' ? 'wav' : 'wav';
        return `${name}.${ext}`;
    }

    downloadFile(url, fileName) {
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
}

window.ExportManager = ExportManager;
