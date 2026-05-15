class MIDIConverter {
    constructor(audioEngine) {
        this.engine = audioEngine;
    }

    async convertToMIDI(buffer, options = {}) {
        const sampleRate = buffer.sampleRate;
        const data = buffer.getChannelData(0);
        const frameSize = options.frameSize || 2048;
        const hopSize = options.hopSize || 512;
        const minFreq = options.minFreq || 60;
        const maxFreq = options.maxFreq || 4000;
        const threshold = options.threshold || 0.01;

        const pitches = [];
        const onsets = [];

        for (let i = 0; i < data.length - frameSize; i += hopSize) {
            const frame = data.slice(i, i + frameSize);

            const rms = Math.sqrt(frame.reduce((s, v) => s + v * v, 0) / frame.length);
            if (rms < threshold) {
                pitches.push({ time: i / sampleRate, freq: 0, amplitude: rms });
                continue;
            }

            const freq = this._detectPitch(frame, sampleRate, minFreq, maxFreq);
            pitches.push({ time: i / sampleRate, freq, amplitude: rms });
        }

        for (let i = 1; i < pitches.length; i++) {
            const prev = pitches[i - 1];
            const curr = pitches[i];
            if (prev.freq === 0 && curr.freq > 0) {
                onsets.push(i);
            } else if (prev.freq > 0 && curr.freq > 0) {
                const ratio = curr.freq / prev.freq;
                if (ratio > 1.05 || ratio < 0.95) {
                    onsets.push(i);
                }
            }
        }

        const notes = this._pitchesToNotes(pitches, onsets);
        const midiData = this._notesToMIDI(notes, options.bpm || 120);

        return {
            notes,
            midiBlob: new Blob([midiData], { type: 'audio/midi' }),
            midiUrl: URL.createObjectURL(new Blob([midiData], { type: 'audio/midi' }))
        };
    }

    _detectPitch(frame, sampleRate, minFreq, maxFreq) {
        const minLag = Math.floor(sampleRate / maxFreq);
        const maxLag = Math.floor(sampleRate / minFreq);
        const n = frame.length;

        const acf = new Float32Array(maxLag + 1);

        for (let lag = minLag; lag <= maxLag; lag++) {
            let sum = 0;
            let norm1 = 0;
            let norm2 = 0;
            for (let i = 0; i < n - lag; i++) {
                sum += frame[i] * frame[i + lag];
                norm1 += frame[i] * frame[i];
                norm2 += frame[i + lag] * frame[i + lag];
            }
            const norm = Math.sqrt(norm1 * norm2);
            acf[lag] = norm > 0 ? sum / norm : 0;
        }

        let bestLag = minLag;
        let bestVal = -1;
        for (let lag = minLag; lag <= maxLag; lag++) {
            if (acf[lag] > bestVal) {
                bestVal = acf[lag];
                bestLag = lag;
            }
        }

        if (bestVal < 0.3) return 0;

        return sampleRate / bestLag;
    }

    _freqToMIDI(freq) {
        if (freq <= 0) return 0;
        return Math.round(69 + 12 * Math.log2(freq / 440));
    }

    _pitchesToNotes(pitches, onsets) {
        const notes = [];
        let currentNote = null;

        for (let i = 0; i < pitches.length; i++) {
            const p = pitches[i];
            const midiNote = this._freqToMIDI(p.freq);

            if (midiNote === 0) {
                if (currentNote) {
                    currentNote.duration = p.time - currentNote.time;
                    if (currentNote.duration > 0.05) {
                        notes.push(currentNote);
                    }
                    currentNote = null;
                }
                continue;
            }

            if (onsets.includes(i) || !currentNote) {
                if (currentNote) {
                    currentNote.duration = p.time - currentNote.time;
                    if (currentNote.duration > 0.05) {
                        notes.push(currentNote);
                    }
                }
                currentNote = {
                    time: p.time,
                    note: midiNote,
                    velocity: Math.min(127, Math.round(p.amplitude * 800)),
                    duration: 0
                };
            } else if (currentNote && midiNote !== currentNote.note) {
                currentNote.duration = p.time - currentNote.time;
                if (currentNote.duration > 0.05) {
                    notes.push(currentNote);
                }
                currentNote = {
                    time: p.time,
                    note: midiNote,
                    velocity: Math.min(127, Math.round(p.amplitude * 800)),
                    duration: 0
                };
            }
        }

        if (currentNote) {
            const lastPitch = pitches[pitches.length - 1];
            currentNote.duration = lastPitch.time - currentNote.time;
            if (currentNote.duration > 0.05) {
                notes.push(currentNote);
            }
        }

        return notes;
    }

    _notesToMIDI(notes, bpm) {
        const ticksPerBeat = 480;
        const microsPerBeat = Math.round(60000000 / bpm);

        const header = this._createMIDIHeader(1, 1, ticksPerBeat);
        const track = this._createMIDITrack(notes, bpm, ticksPerBeat);

        const result = new Uint8Array(header.length + track.length);
        result.set(header, 0);
        result.set(track, header.length);

        return result;
    }

    _createMIDIHeader(format, tracks, ticksPerBeat) {
        return new Uint8Array([
            0x4D, 0x54, 0x68, 0x64,
            0x00, 0x00, 0x00, 0x06,
            0x00, format,
            0x00, tracks,
            (ticksPerBeat >> 8) & 0xFF, ticksPerBeat & 0xFF
        ]);
    }

    _createMIDITrack(notes, bpm, ticksPerBeat) {
        const events = [];
        const microsPerBeat = Math.round(60000000 / bpm);

        events.push([0, 0xFF, 0x51, 0x03,
            (microsPerBeat >> 16) & 0xFF,
            (microsPerBeat >> 8) & 0xFF,
            microsPerBeat & 0xFF
        ]);

        const secondsPerTick = 60 / (bpm * ticksPerBeat);

        notes.forEach(note => {
            const startTick = Math.round(note.time / secondsPerTick);
            const durationTicks = Math.max(1, Math.round(note.duration / secondsPerTick));
            const vel = Math.max(1, Math.min(127, note.velocity));

            events.push([startTick, 0x90, note.note & 0x7F, vel]);
            events.push([startTick + durationTicks, 0x80, note.note & 0x7F, 0]);
        });

        events.sort((a, b) => a[0] - b[0]);

        const trackData = [];
        let lastTick = 0;

        events.forEach(event => {
            const deltaTick = event[0] - lastTick;
            lastTick = event[0];

            const vlq = this._toVLQ(deltaTick);
            trackData.push(...vlq);

            for (let i = 1; i < event.length; i++) {
                trackData.push(event[i]);
            }
        });

        trackData.push(0x00, 0xFF, 0x2F, 0x00);

        const trackHeader = [
            0x4D, 0x54, 0x72, 0x6B,
            (trackData.length >> 24) & 0xFF,
            (trackData.length >> 16) & 0xFF,
            (trackData.length >> 8) & 0xFF,
            trackData.length & 0xFF
        ];

        return new Uint8Array([...trackHeader, ...trackData]);
    }

    _toVLQ(value) {
        if (value < 0) value = 0;
        const bytes = [];
        bytes.push(value & 0x7F);
        value >>= 7;
        while (value > 0) {
            bytes.push((value & 0x7F) | 0x80);
            value >>= 7;
        }
        return bytes.reverse();
    }

    getNoteNames() {
        return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    }

    midiNoteToName(note) {
        const names = this.getNoteNames();
        const octave = Math.floor(note / 12) - 1;
        return names[note % 12] + octave;
    }
}

window.MIDIConverter = MIDIConverter;
