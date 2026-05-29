class AudioEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.masterAnalyserL = null;
        this.masterAnalyserR = null;
        this.masterCompressor = null;
        this.masterLimiter = null;
        this.masterEQ = {};
        this.splitter = null;
        this.merger = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.startTime = 0;
        this.pauseTime = 0;
        this.loopEnabled = false;
        this.loopStart = 0;
        this.loopEnd = 0;
        this.sources = [];
        this.tracks = [];
        this.bpm = 120;
        this.originalBpm = 120;  // ファイルロード時に検出したBPM
        this.bpmRatio = 1.0;     // 再生速度比率 = bpm / originalBpm
        this.onTimeUpdate = null;
        this._rafId = null;
    }

    async init() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });

        this.masterCompressor = this.ctx.createDynamicsCompressor();
        this.masterCompressor.threshold.value = -24;
        this.masterCompressor.knee.value = 12;
        this.masterCompressor.ratio.value = 4;
        this.masterCompressor.attack.value = 0.01;
        this.masterCompressor.release.value = 0.25;

        this.masterLimiter = this.ctx.createDynamicsCompressor();
        this.masterLimiter.threshold.value = -0.3;
        this.masterLimiter.knee.value = 0;
        this.masterLimiter.ratio.value = 20;
        this.masterLimiter.attack.value = 0.001;
        this.masterLimiter.release.value = 0.01;

        const bands = [
            { name: 'low', freq: 80, type: 'lowshelf' },
            { name: 'lowmid', freq: 400, type: 'peaking' },
            { name: 'mid', freq: 1000, type: 'peaking' },
            { name: 'highmid', freq: 4000, type: 'peaking' },
            { name: 'high', freq: 12000, type: 'highshelf' }
        ];

        let prevNode = this.masterCompressor;
        bands.forEach(band => {
            const filter = this.ctx.createBiquadFilter();
            filter.type = band.type;
            filter.frequency.value = band.freq;
            filter.gain.value = 0;
            if (band.type === 'peaking') filter.Q.value = 1.5;
            prevNode.connect(filter);
            prevNode = filter;
            this.masterEQ[band.name] = filter;
        });

        prevNode.connect(this.masterLimiter);

        this.masterGain = this.ctx.createGain();
        this.masterLimiter.connect(this.masterGain);

        this.splitter = this.ctx.createChannelSplitter(2);
        this.merger = this.ctx.createChannelMerger(2);

        this.masterAnalyserL = this.ctx.createAnalyser();
        this.masterAnalyserL.fftSize = 2048;       // スペクトラム解像度UP（メーターにも影響なし）
        this.masterAnalyserL.smoothingTimeConstant = 0.8;
        this.masterAnalyserR = this.ctx.createAnalyser();
        this.masterAnalyserR.fftSize = 2048;
        this.masterAnalyserR.smoothingTimeConstant = 0.8;

        this.masterGain.connect(this.splitter);
        this.splitter.connect(this.masterAnalyserL, 0);
        this.splitter.connect(this.masterAnalyserR, 1);
        this.masterGain.connect(this.ctx.destination);
    }

    async resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }
    }

    async decodeAudio(arrayBuffer) {
        return await this.ctx.decodeAudioData(arrayBuffer);
    }

    createTrackNodes() {
        const gainNode = this.ctx.createGain();
        const panNode  = this.ctx.createStereoPanner();
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 1024; // 高解像度でレベルメーター精度向上

        // ── 3バンドEQ ──────────────────────────────
        const eqLow  = this.ctx.createBiquadFilter();
        eqLow.type  = 'lowshelf';
        eqLow.frequency.value = 200;
        eqLow.gain.value = 0;

        const eqMid  = this.ctx.createBiquadFilter();
        eqMid.type  = 'peaking';
        eqMid.frequency.value = 1500;
        eqMid.Q.value = 1.2;
        eqMid.gain.value = 0;

        const eqHigh = this.ctx.createBiquadFilter();
        eqHigh.type = 'highshelf';
        eqHigh.frequency.value = 5000;
        eqHigh.gain.value = 0;

        // ── リバーブ（dry/wet ミックス） ──────────────
        const reverbDry = this.ctx.createGain();
        const reverbWet = this.ctx.createGain();
        reverbDry.gain.value = 1.0;
        reverbWet.gain.value = 0.0;   // 初期はリバーブなし

        const convolver = this.ctx.createConvolver();
        const irLen = Math.floor(this.ctx.sampleRate * 2.5); // 2.5秒IR
        const ir = this.ctx.createBuffer(2, irLen, this.ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
            const d = ir.getChannelData(ch);
            for (let i = 0; i < irLen; i++) {
                // 指数減衰するランダムノイズ（室内残響シミュレーション）
                d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.8);
            }
        }
        convolver.buffer = ir;

        const reverbMix = this.ctx.createGain(); // wet+dry合流点
        reverbMix.gain.value = 1.0;

        // ── グラフ接続 ──────────────────────────────
        // source → gainNode → panNode → eqLow → eqMid → eqHigh
        //       ↳ reverbDry → reverbMix → analyser → masterCompressor
        //       ↳ convolver → reverbWet ↗
        gainNode.connect(panNode);
        panNode.connect(eqLow);
        eqLow.connect(eqMid);
        eqMid.connect(eqHigh);

        eqHigh.connect(reverbDry);
        eqHigh.connect(convolver);

        reverbDry.connect(reverbMix);
        convolver.connect(reverbWet);
        reverbWet.connect(reverbMix);

        // ── スウィープ専用フィルター（FXクリップ用） ──────────────
        const sweepFilter = this.ctx.createBiquadFilter();
        sweepFilter.type = 'lowpass';
        sweepFilter.frequency.value = 22050; // デフォルトは全通過（バイパス）
        sweepFilter.Q.value = 1.5;

        reverbMix.connect(sweepFilter);
        sweepFilter.connect(analyser);
        analyser.connect(this.masterCompressor);

        return { gainNode, panNode, analyser, eqLow, eqMid, eqHigh, reverbWet, reverbDry, convolver, sweepFilter };
    }

    getCurrentTime() {
        if (!this.isPlaying) return this.pauseTime;
        // bpmRatioが1以外のとき、実経過時間 × 速度比 = 音楽時間
        return (this.ctx.currentTime - this.startTime) * (this.bpmRatio || 1.0) + this.pauseTime;
    }

    play(tracks) {
        if (!this.ctx) return;
        this.resume();

        this.stopAllSources();
        this.sources = [];

        const offset = this.pauseTime;
        this.startTime = this.ctx.currentTime;

        tracks.forEach(track => {
            if (!track.clips || track.muted) return;
            track.clips.forEach(clip => {
                if (!clip.buffer) return;
                const source = this.ctx.createBufferSource();
                source.buffer = clip.buffer;

                const clipStart = clip.startTime || 0;
                // clipEndは元の音楽時間（buffer duration = 1xの長さ）で判定
                const clipEnd = clipStart + clip.buffer.duration;

                if (offset >= clipEnd) return;

                source.connect(track.nodes.gainNode);

                // sourceOffsetは バッファ内の位置（音楽時間）= offset - clipStart
                const sourceOffset = Math.max(0, offset - clipStart);
                // whenはwallclock実時間: 音楽時間の差をbpmRatioで割る（速いほど早く到達）
                const when = Math.max(0, (clipStart - offset) / (this.bpmRatio || 1.0));

                // BPM変更に応じて再生速度を変える（varispeed: テンポ＆ピッチ同時変化）
                source.playbackRate.value = this.bpmRatio || 1.0;
                source.start(this.ctx.currentTime + when, sourceOffset);
                this.sources.push(source);
            });
        });

        this.isPlaying = true;
        this.isPaused = false;
        this._startTimeUpdate();
    }

    pause() {
        this.pauseTime = this.getCurrentTime();
        this.stopAllSources();
        this.isPlaying = false;
        this.isPaused = true;
        this._stopTimeUpdate();
    }

    stop() {
        this.stopAllSources();
        this.pauseTime = 0;
        this.isPlaying = false;
        this.isPaused = false;
        this._stopTimeUpdate();
        if (this.onTimeUpdate) this.onTimeUpdate(0);
    }

    stopAllSources() {
        this.sources.forEach(s => {
            try { s.stop(); } catch (e) {}
        });
        this.sources = [];
    }

    seek(time) {
        this.pauseTime = Math.max(0, time);
        if (this.isPlaying) {
            this.play(this.tracks);
        } else if (this.onTimeUpdate) {
            this.onTimeUpdate(this.pauseTime);
        }
    }

    setMasterVolume(value) {
        if (this.masterGain) {
            this.masterGain.gain.setValueAtTime(value, this.ctx.currentTime);
        }
    }

    setMasterEQ(band, value) {
        if (this.masterEQ[band]) {
            this.masterEQ[band].gain.setValueAtTime(value, this.ctx.currentTime);
        }
    }

    // ── Suno AI ワンクリックEQ ──────────────────────────────
    // AI生成楽曲特有の「高音のシャリシャリ感」「低音のもっさり感」を補正する。
    // マスターEQ（lowshelf/peaking/highshelf）にプリセット値を適用する。
    // enabled=false で元の値を復元（ユーザー設定を破壊しない）。
    setSunoEQPreset(enabled) {
        if (!this.masterEQ || Object.keys(this.masterEQ).length === 0) return;

        if (enabled) {
            // 現在のマスターEQ値をバックアップ（多重適用を防ぐ）
            if (!this._presunoEQ) {
                this._presunoEQ = {};
                Object.keys(this.masterEQ).forEach(band => {
                    this._presunoEQ[band] = this.masterEQ[band].gain.value;
                });
            }
            // Suno最適化プリセット
            this.setMasterEQ('low',      1.5);  // 薄くなりがちな低音を補強
            this.setMasterEQ('lowmid',  -3.0);  // AIのこもり感（200-400Hz）を除去
            this.setMasterEQ('mid',      0.5);  // ボーカル帯域の存在感を少し
            this.setMasterEQ('highmid', -2.0);  // シャリシャリの中心帯域をカット
            this.setMasterEQ('high',    -3.5);  // AIの高音シマー感を抑制
        } else {
            // バックアップから復元
            if (this._presunoEQ) {
                Object.keys(this._presunoEQ).forEach(band => {
                    this.setMasterEQ(band, this._presunoEQ[band]);
                });
                this._presunoEQ = null;
            }
        }
        this.sunoEnabled = enabled;
        return this.sunoEnabled;
    }

    setMasterCompressor(param, value) {
        if (this.masterCompressor) {
            switch (param) {
                case 'threshold': this.masterCompressor.threshold.value = value; break;
                case 'ratio': this.masterCompressor.ratio.value = value; break;
                case 'attack': this.masterCompressor.attack.value = value / 1000; break;
                case 'release': this.masterCompressor.release.value = value / 1000; break;
            }
        }
    }

    setMasterLimiter(param, value) {
        if (this.masterLimiter) {
            switch (param) {
                case 'ceiling': this.masterLimiter.threshold.value = value; break;
                case 'gain':
                    this.masterGain.gain.setValueAtTime(
                        Math.pow(10, value / 20),
                        this.ctx.currentTime
                    );
                    break;
            }
        }
    }

    getMeterData(analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        return sum / data.length / 255;
    }

    _startTimeUpdate() {
        const update = () => {
            if (!this.isPlaying) return;
            const time = this.getCurrentTime();
            if (this.onTimeUpdate) this.onTimeUpdate(time);

            if (this.loopEnabled && time >= this.loopEnd && this.loopEnd > this.loopStart) {
                this.pauseTime = this.loopStart;
                this.play(this.tracks);
                return;
            }

            this._rafId = requestAnimationFrame(update);
        };
        this._rafId = requestAnimationFrame(update);
    }

    _stopTimeUpdate() {
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    renderOffline(tracks, duration, sampleRate = 44100) {
        const offlineCtx = new OfflineAudioContext(2, duration * sampleRate, sampleRate);

        const masterGain = offlineCtx.createGain();
        masterGain.connect(offlineCtx.destination);

        const compressor = offlineCtx.createDynamicsCompressor();
        compressor.threshold.value = this.masterCompressor.threshold.value;
        compressor.ratio.value = this.masterCompressor.ratio.value;
        compressor.attack.value = this.masterCompressor.attack.value;
        compressor.release.value = this.masterCompressor.release.value;

        const limiter = offlineCtx.createDynamicsCompressor();
        limiter.threshold.value = this.masterLimiter.threshold.value;
        limiter.ratio.value = this.masterLimiter.ratio.value;
        limiter.attack.value = this.masterLimiter.attack.value;
        limiter.release.value = this.masterLimiter.release.value;

        let prevNode = compressor;
        Object.keys(this.masterEQ).forEach(bandName => {
            const origFilter = this.masterEQ[bandName];
            const filter = offlineCtx.createBiquadFilter();
            filter.type = origFilter.type;
            filter.frequency.value = origFilter.frequency.value;
            filter.gain.value = origFilter.gain.value;
            if (origFilter.Q) filter.Q.value = origFilter.Q.value;
            prevNode.connect(filter);
            prevNode = filter;
        });

        prevNode.connect(limiter);
        limiter.connect(masterGain);

        tracks.forEach(track => {
            if (track.muted) return;
            const gain = offlineCtx.createGain();
            gain.gain.value = track.volume;
            const pan = offlineCtx.createStereoPanner();
            pan.pan.value = track.pan;
            gain.connect(pan);
            pan.connect(compressor);

            track.clips.forEach(clip => {
                if (!clip.buffer) return;
                const source = offlineCtx.createBufferSource();
                source.buffer = clip.buffer;
                source.connect(gain);
                source.start(clip.startTime || 0);
            });
        });

        return offlineCtx.startRendering();
    }
}

window.AudioEngine = AudioEngine;
