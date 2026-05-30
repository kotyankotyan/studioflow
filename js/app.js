/** HTML特殊文字をエスケープするユーティリティ */
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

class StudioFlowDAW {
    constructor() {
        this.audioEngine = new AudioEngine();
        this.waveform = new WaveformRenderer();
        this.effects = new EffectsProcessor(this.audioEngine);
        this.stemSeparator = new StemSeparator(this.audioEngine);
        this.vocalProcessor = new VocalProcessor(this.audioEngine);
        this.automation = new AutomationManager();
        this.mastering = new MasteringEngine(this.audioEngine);
        this.remix = new RemixEngine(this.audioEngine);
        this.proTools = new ProTools(this.audioEngine);
        this.midiConverter = new MIDIConverter(this.audioEngine);
        this.exportManager = new ExportManager(this.audioEngine);
        this.creator = new CreatorEngine(this.audioEngine);

        this.tracks = [];
        this.selectedTrack = null;
        this.selectedClip = null;
        this.currentTool = 'select';
        this.pixelsPerSecond = 100;
        this.scrollOffset = 0;
        this.undoStack = [];
        this.redoStack = [];
        this.trackColors = [
            '#4a9eff', '#22c55e', '#e94560', '#eab308',
            '#a855f7', '#f97316', '#06b6d4', '#ec4899',
            '#6366f1', '#14b8a6', '#f43f5e', '#84cc16'
        ];
        this._meterRAF = null;

        // Easy mode state
        this.easyMode = true;
        this.isComparing = false;
        this.savedVolumes = {};
        this.currentPreset = null;
    }

    async init() {
        await this.audioEngine.init();
        this.audioEngine.onTimeUpdate = (time) => this._updatePlayhead(time);

        // ストレージ初期化
        this.storage = new StorageManager();
        await this.storage.open();

        // モーダル/ポップアップを最上位へ移動（簡単モードでも正しく開くように）
        this._relocateOverlays();

        this._setupEventListeners();
        this._setupEasyModeListeners();
        this._setupCreatorListeners();
        this._setupDragDrop();
        this._setupKeyboardShortcuts();

        this.automation.init(document.getElementById('automation-canvas'));

        // 保存済みプロジェクトを復元、なければデフォルトトラック
        const restored = await this._restoreProject();
        if (!restored) {
            this._addDefaultTracks();
        }

        this._startMeters();
        this._updateRuler();
        this._updateMixerUI();

        // ストレージ使用量を表示
        this._updateStorageIndicator();
    }

    /**
     * モーダル・ポップアップ類を #app 直下へ移動する。
     * これらは元々 #advanced-mode 内にあり、簡単モード（advanced-mode が
     * display:none）では開いても表示されず、状態だけ残って上級者モード
     * 切替時に一斉に開く不具合があった。最上位に移すことで両モードで
     * 正しくオーバーレイ表示される。
     */
    _relocateOverlays() {
        const app = document.getElementById('app');
        if (!app) return;
        const overlays = document.querySelectorAll('.modal, #preset-popup');
        overlays.forEach(el => {
            // 念のため閉じた状態にしてから移動
            el.classList.add('hidden');
            if (el.parentElement !== app) app.appendChild(el);
        });
    }

    /** 開いている全モーダル/ポップアップを閉じる（モード切替時の安全策） */
    _closeAllOverlays() {
        document.querySelectorAll('.modal:not(.hidden), #preset-popup:not(.hidden)')
            .forEach(el => el.classList.add('hidden'));
    }

    // ============================================
    // EASY MODE
    // ============================================

    _setupEasyModeListeners() {
        // Import button
        document.getElementById('btn-easy-import').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });

        // Demo button
        document.getElementById('btn-easy-demo').addEventListener('click', () => {
            this._createDemoProject();
        });

        // Reimport
        document.getElementById('btn-easy-reimport').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });

        // Preset popup
        document.getElementById('btn-easy-preset').addEventListener('click', () => {
            document.getElementById('preset-popup').classList.remove('hidden');
        });

        // Preset cards
        document.querySelectorAll('.preset-card').forEach(card => {
            card.addEventListener('click', () => {
                const preset = card.dataset.preset;
                this._applyEasyPreset(preset);
                document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active-preset'));
                card.classList.add('active-preset');
                this.currentPreset = preset;
                document.getElementById('preset-popup').classList.add('hidden');
            });
        });

        // Compare button
        document.getElementById('btn-easy-compare').addEventListener('click', () => {
            this.isComparing = !this.isComparing;
            document.getElementById('btn-easy-compare').classList.toggle('active', this.isComparing);

            if (this.isComparing) {
                // 原曲と比較: 編集済みトラックをミュートし、参照トラックを聴かせる
                this.savedVolumes = {};
                this.tracks.forEach(t => {
                    this.savedVolumes[t.id] = { volume: t.volume, muted: t.muted };
                    if (t._isReference) {
                        // 参照用トラックをミュート解除して聴かせる
                        t.muted = false;
                        t.nodes.gainNode.gain.value = 0.85;
                    } else {
                        // 編集済みトラックをミュート
                        t.muted = true;
                        t.nodes.gainNode.gain.value = 0;
                    }
                });
                this._updateEasyCardsState();
                this._toast('🔇 原曲（調整前）を再生中... もう一度押すと調整後に戻ります', 'info');
            } else {
                // 調整後に戻す
                this.tracks.forEach(t => {
                    if (this.savedVolumes[t.id]) {
                        t.volume = this.savedVolumes[t.id].volume;
                        t.muted = this.savedVolumes[t.id].muted;
                        t.nodes.gainNode.gain.value = t.muted ? 0 : t.volume;
                    }
                });
                this._updateEasyCardsState();
                this._toast('✅ 調整後のミックスに戻しました', 'info');
            }
        });

        // Clear / delete project
        document.getElementById('btn-easy-clear').addEventListener('click', () => {
            this._clearProject();
        });

        document.getElementById('btn-easy-reset').addEventListener('click', () => {
            this._resetAllToDefaults();
        });

        // Toggle advanced mode
        document.getElementById('btn-toggle-advanced').addEventListener('click', () => {
            this._switchToAdvanced();
        });

        // Back to easy mode
        document.getElementById('btn-back-to-easy').addEventListener('click', () => {
            this._switchToEasy();
        });

        // Easy export
        document.getElementById('btn-easy-export').addEventListener('click', () => {
            document.getElementById('modal-export').classList.remove('hidden');
        });
    }

    _switchToAdvanced() {
        this._closeAllOverlays(); // 切替時に開きかけのモーダルを一掃
        this.easyMode = false;
        document.getElementById('easy-mode').classList.add('hidden');
        document.getElementById('advanced-mode').classList.remove('hidden');
        document.getElementById('btn-back-to-easy').classList.remove('hidden');
        this._updateMixerUI();
        this._updateRuler();
        this.automation.draw();
        // 非表示中に追加されたクリップの波形を再描画
        // display:none 解除後、ブラウザがレイアウトを確定するまでリトライ
        const _redrawAllClips = (attempts) => {
            let allDrawn = true;
            this.tracks.forEach(track => {
                track.clips.forEach(clip => {
                    if (!clip.buffer) return;
                    const clipEl = document.querySelector(`[data-clip-id="${clip.id}"]`);
                    if (!clipEl) return;
                    const canvas = clipEl.querySelector('.clip-waveform');
                    if (!canvas) return;
                    const r = canvas.getBoundingClientRect();
                    if (r.width > 0) {
                        this.waveform.drawClipWaveform(canvas, clip.buffer, clip.offset || 0, clip.duration);
                    } else {
                        allDrawn = false;
                    }
                });
            });
            if (!allDrawn && attempts < 15) {
                setTimeout(() => _redrawAllClips(attempts + 1), 50);
            }
        };
        setTimeout(() => _redrawAllClips(0), 0);

        // かんたんモードで変更した値を上級者モードのスライダー・ボタンに同期
        this._syncAdvancedTrackHeaders();
    }

    /** かんたんモードの設定値を上級者モードのトラックヘッダーUIに反映する */
    _syncAdvancedTrackHeaders() {
        this.tracks.forEach(track => {
            const trackDiv = document.querySelector(`[data-track-id="${track.id}"].track`);
            if (!trackDiv) return;

            // 音量スライダー
            const volSlider = trackDiv.querySelector('.track-vol-slider');
            if (volSlider) {
                volSlider.value = track.volume;
                const label = trackDiv.querySelector('.track-volume-label');
                if (label) label.textContent = Math.round(track.volume * 100) + '%';
            }

            // パンスライダー
            const panSlider = trackDiv.querySelector('.track-pan-slider');
            if (panSlider) panSlider.value = track.pan;

            // ミュートボタン
            const muteBtn = trackDiv.querySelector('.btn-mute');
            if (muteBtn) muteBtn.classList.toggle('active-mute', track.muted);

            // ソロボタン
            const soloBtn = trackDiv.querySelector('.btn-solo');
            if (soloBtn) soloBtn.classList.toggle('active-solo', track.solo);

            // トラック名
            const nameInput = trackDiv.querySelector('.track-name');
            if (nameInput) nameInput.value = track.name;
        });
    }

    _switchToEasy() {
        this._closeAllOverlays();
        this.easyMode = true;
        document.getElementById('advanced-mode').classList.add('hidden');
        document.getElementById('easy-mode').classList.remove('hidden');
        document.getElementById('btn-back-to-easy').classList.add('hidden');
        this._renderEasyCards();
    }

    _setStep(step) {
        document.querySelectorAll('.step').forEach(s => {
            const n = parseInt(s.dataset.step);
            s.classList.remove('active', 'done');
            if (n < step) s.classList.add('done');
            if (n === step) s.classList.add('active');
        });
    }

    _renderEasyCards() {
        const area = document.getElementById('easy-parts-area');
        const emptyState = document.getElementById('easy-empty-state');
        const actionBar = document.getElementById('easy-action-bar');

        // Check if we have tracks with clips
        const tracksWithClips = this.tracks.filter(t => t.clips.length > 0);
        if (tracksWithClips.length === 0) {
            if (emptyState) emptyState.style.display = '';
            actionBar.classList.add('hidden');
            this._setStep(1);
            return;
        }

        if (emptyState) emptyState.style.display = 'none';
        actionBar.classList.remove('hidden');
        this._setStep(2);

        // Remove old cards
        area.querySelectorAll('.easy-parts-grid').forEach(g => g.remove());

        const grid = document.createElement('div');
        grid.className = 'easy-parts-grid';

        const stemInfo = {
            'ボーカル': { icon: '🎤', part: 'vocals' },
            'ドラム': { icon: '🥁', part: 'drums' },
            'ベース': { icon: '🎸', part: 'bass' },
            'その他': { icon: '🎹', part: 'other' },
            '原曲': { icon: '🎵', part: 'original' },
            'メロディ': { icon: '🎵', part: 'vocals' },
            'パッド': { icon: '🎹', part: 'other' },
        };

        tracksWithClips.forEach(track => {
            // Figure out which stem type this track is
            let info = { icon: '🎵', part: 'other' };
            for (const [key, val] of Object.entries(stemInfo)) {
                if (track.name.includes(key)) { info = val; break; }
            }

            const isOriginal = track.name.includes('原曲') || track.name.includes('参照用') || track._isReference;
            const isAIMix = !!track._isAIMix;

            if (isAIMix) {
                info = { icon: '🎵', part: 'fullmix' };
            } else if (isOriginal || track._isReference) {
                info = { icon: '🔇', part: 'original' };
            }

            const card = document.createElement('div');
            card.className = 'part-card' + (track.muted ? ' is-muted' : '') + (isAIMix ? ' ai-mix-card' : '');
            card.dataset.part = info.part;
            card.dataset.trackId = track.id;

            const cleanName = track.name.replace(/^\S+\s+/, '') || track.name;

            // 変化量 計算
            const changePct = this._computeChangePct(track);
            const changeBadgeHtml = !isOriginal ? `
                <div class="change-badge" data-change-badge="${track.id}" style="--change-pct:${changePct}%">
                    <span class="change-badge-label">変化量</span>
                    <span class="change-badge-val">${changePct}%</span>
                    <div class="change-badge-bar"><div class="change-badge-fill" style="width:${changePct}%"></div></div>
                </div>` : '';

            card.innerHTML = `
                <div class="part-card-header">
                    <div class="part-card-title">
                        <span class="part-icon">${info.icon}</span>
                        <span class="part-name">${escapeHtml(cleanName)}</span>
                    </div>
                    <div class="part-card-actions">
                        ${!isOriginal ? `<button class="part-btn btn-part-preview" data-track-id="${track.id}" title="5秒だけ試聴"><i class="fas fa-play"></i></button>` : ''}
                        ${!isOriginal ? `<button class="part-btn btn-part-solo" data-track-id="${track.id}" title="このパートだけ聴く"><i class="fas fa-headphones"></i></button>` : ''}
                        <button class="part-btn btn-part-mute ${track.muted ? 'muted' : ''}" data-track-id="${track.id}" title="${isOriginal ? '原曲を再生する' : 'ミュート'}">
                            <i class="fas fa-${track.muted ? 'volume-mute' : 'volume-up'}"></i>
                        </button>
                    </div>
                </div>
                ${changeBadgeHtml}
                <div class="part-waveform">
                    <canvas data-track-id="${track.id}"></canvas>
                    <div class="part-level-meter" data-meter="${track.id}">
                        <div class="meter-bar" data-meter-bar="${track.id}"></div>
                        <span class="meter-label">音量</span>
                    </div>
                </div>
                <div class="part-controls">
                    ${isOriginal ? `
                    <div class="ref-track-info">
                        <i class="fas fa-info-circle"></i>
                        <span>▶ボタンで原曲と今の音を聴き比べできます</span>
                    </div>
                    ` : `
                    <div class="part-slider-group vol-slider-group">
                        <span class="part-slider-label"><i class="fas fa-volume-up"></i> 音量</span>
                        <div class="vol-stepper-wrap">
                            <button class="vol-step-btn" data-track-id="${track.id}" data-step="-0.1" title="音量を下げる">－</button>
                            <input type="range" class="part-slider volume-slider" data-track-id="${track.id}" data-param="volume" min="0" max="1.5" step="0.05" value="${track.volume}">
                            <button class="vol-step-btn" data-track-id="${track.id}" data-step="0.1" title="音量を上げる">＋</button>
                        </div>
                        <span class="part-slider-value vol-val-label">${Math.round(track.volume * 100)}%</span>
                    </div>
                    ${isAIMix ? `
                    <div class="part-slider-group ms-vocal-group">
                        <span class="part-slider-label ms-vocal-label">🎤 ボーカル除去</span>
                        <input type="range" class="part-slider ms-vocal-slider" data-track-id="${track.id}" data-param="ms-vocal" min="0" max="100" step="5" value="${track._msVocalReduction || 0}">
                        <span class="part-slider-value ms-vocal-val">${track._msVocalReduction ? track._msVocalReduction + '% 除去中' : '変化なし'}</span>
                    </div>
                    <div class="ms-vocal-status" data-ms-status="${track.id}"></div>
                    ` : ''}
                    <div class="part-slider-group">
                        <span class="part-slider-label"><i class="fas fa-church"></i> 響き</span>
                        <input type="range" class="part-slider effect-slider" data-track-id="${track.id}" data-param="reverb" min="0" max="100" step="1" value="${this._getTrackEffectValue(track, 'reverb')}">
                        <span class="part-slider-value">${this._getTrackEffectValue(track, 'reverb')}%</span>
                    </div>
                    <div class="part-slider-group">
                        <span class="part-slider-label"><i class="fas fa-arrows-alt-h"></i> 左右</span>
                        <input type="range" class="part-slider pan-slider" data-track-id="${track.id}" data-param="pan" min="-1" max="1" step="0.01" value="${track.pan}">
                        <span class="part-slider-value">${track.pan === 0 ? '中央' : (track.pan < 0 ? 'L' + Math.round(-track.pan * 100) : 'R' + Math.round(track.pan * 100))}</span>
                    </div>
                    <div class="part-eq-section">
                        <div class="part-eq-label"><i class="fas fa-sliders-h"></i> 音質調整（EQ）</div>
                        <div class="part-eq-grid">
                            <div class="eq-band">
                                <span class="eq-band-label">低音</span>
                                <input type="range" class="eq-slider" data-track-id="${track.id}" data-eq="low" min="-12" max="12" step="1" value="${track._eqLow || 0}">
                                <span class="eq-band-val" data-eq-val="${track.id}-low">${track._eqLow ? (track._eqLow > 0 ? '+' : '') + track._eqLow + 'dB' : '±0'}</span>
                            </div>
                            <div class="eq-band">
                                <span class="eq-band-label">中音</span>
                                <input type="range" class="eq-slider" data-track-id="${track.id}" data-eq="mid" min="-12" max="12" step="1" value="${track._eqMid || 0}">
                                <span class="eq-band-val" data-eq-val="${track.id}-mid">${track._eqMid ? (track._eqMid > 0 ? '+' : '') + track._eqMid + 'dB' : '±0'}</span>
                            </div>
                            <div class="eq-band">
                                <span class="eq-band-label">高音</span>
                                <input type="range" class="eq-slider" data-track-id="${track.id}" data-eq="high" min="-12" max="12" step="1" value="${track._eqHigh || 0}">
                                <span class="eq-band-val" data-eq-val="${track.id}-high">${track._eqHigh ? (track._eqHigh > 0 ? '+' : '') + track._eqHigh + 'dB' : '±0'}</span>
                            </div>
                        </div>
                    </div>
                    `}
                </div>

                <!-- 🎛 動きFXボタン -->
                ${!isOriginal ? `
                <div class="part-fx-section">
                    <button class="part-fx-btn" data-track-id="${track.id}">
                        <i class="fas fa-magic"></i> 動きFX
                        ${(track.fxClips?.length) ? `<span class="fx-badge">${track.fxClips.length}</span>` : ''}
                    </button>
                </div>` : ''}

                <!-- ✂️ 編集パネル（切り抜き・フェード） -->
                <div class="part-edit-section">
                    <button class="part-edit-toggle" data-track-id="${track.id}">
                        <i class="fas fa-cut"></i> 編集する
                        <i class="fas fa-chevron-down part-edit-chevron"></i>
                    </button>
                    <div class="part-edit-panel hidden" data-edit-panel="${track.id}">
                        <div class="edit-waveform-wrap">
                            <canvas class="edit-waveform-canvas" data-edit-canvas="${track.id}" height="44"></canvas>
                            <div class="edit-range-overlay">
                                <div class="edit-range-bar" data-range-bar="${track.id}"></div>
                            </div>
                        </div>
                        <div class="edit-controls-grid">
                            <div class="edit-ctrl-row">
                                <span class="edit-ctrl-label"><i class="fas fa-step-forward fa-flip-horizontal"></i> 開始</span>
                                <input type="range" class="edit-slider" data-track-id="${track.id}" data-edit="start"
                                    min="0" max="${(track.clips[0]?.buffer?.duration || 30).toFixed(1)}"
                                    step="0.1" value="${track._editStart || 0}">
                                <span class="edit-ctrl-value" data-edit-val="${track.id}-start">${this._fmtSec(track._editStart || 0)}</span>
                            </div>
                            <div class="edit-ctrl-row">
                                <span class="edit-ctrl-label"><i class="fas fa-step-forward"></i> 終了</span>
                                <input type="range" class="edit-slider" data-track-id="${track.id}" data-edit="end"
                                    min="0" max="${(track.clips[0]?.buffer?.duration || 30).toFixed(1)}"
                                    step="0.1" value="${track._editEnd || (track.clips[0]?.buffer?.duration || 30).toFixed(1)}">
                                <span class="edit-ctrl-value" data-edit-val="${track.id}-end">${this._fmtSec(track._editEnd || track.clips[0]?.buffer?.duration || 30)}</span>
                            </div>
                            <div class="edit-ctrl-row">
                                <span class="edit-ctrl-label"><i class="fas fa-level-up-alt"></i> フェードイン</span>
                                <input type="range" class="edit-slider" data-track-id="${track.id}" data-edit="fadeIn"
                                    min="0" max="10" step="0.1" value="${track._editFadeIn || 0}">
                                <span class="edit-ctrl-value" data-edit-val="${track.id}-fadeIn">${track._editFadeIn ? track._editFadeIn + '秒' : 'なし'}</span>
                            </div>
                            <div class="edit-ctrl-row">
                                <span class="edit-ctrl-label"><i class="fas fa-level-down-alt"></i> フェードアウト</span>
                                <input type="range" class="edit-slider" data-track-id="${track.id}" data-edit="fadeOut"
                                    min="0" max="10" step="0.1" value="${track._editFadeOut || 0}">
                                <span class="edit-ctrl-value" data-edit-val="${track.id}-fadeOut">${track._editFadeOut ? track._editFadeOut + '秒' : 'なし'}</span>
                            </div>
                        </div>
                        <div class="edit-apply-row">
                            <button class="edit-apply-btn" data-track-id="${track.id}">
                                <i class="fas fa-check"></i> 適用する
                            </button>
                            ${track._originalBuffer ? `
                            <button class="edit-reset-btn" data-track-id="${track.id}">
                                <i class="fas fa-undo"></i> 元に戻す
                            </button>` : ''}
                            <span class="edit-status" data-edit-status="${track.id}"></span>
                        </div>
                    </div>
                </div>
            `;

            grid.appendChild(card);

            // Draw mini waveform（フォールバック付きで即描画 + 念のため遅延でも再描画）
            const _drawCard = () => {
                const canvas = card.querySelector('.part-waveform canvas');
                if (!canvas || !track.clips[0]?.buffer) return;
                this.waveform.drawClipWaveform(canvas, track.clips[0].buffer, 0, track.clips[0].duration);
            };
            setTimeout(_drawCard, 0);
            setTimeout(_drawCard, 300); // レイアウト確定後に再描画
        });

        area.appendChild(grid);
        this._setupEasyCardEvents(grid);
    }

    _setupEasyCardEvents(grid) {
        // 音量: スライダー＋ステップボタン共通の更新ヘルパー
        const _applyVolume = (track, newVol, group) => {
            track.volume = Math.max(0, Math.min(1.5, newVol));
            if (!track.muted) {
                track.nodes.gainNode.gain.setValueAtTime(track.volume, this.audioEngine.ctx.currentTime);
            }
            const slider = group.querySelector('[data-param="volume"]');
            const label  = group.querySelector('.vol-val-label') || group.querySelector('.part-slider-value');
            if (slider) slider.value = track.volume;
            if (label)  label.textContent = Math.round(track.volume * 100) + '%';
            this._updateChangeBadge(track);
        };

        // Volume sliders
        grid.querySelectorAll('[data-param="volume"]').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const track = this.tracks.find(t => t.id === e.target.dataset.trackId);
                if (!track) return;
                _applyVolume(track, parseFloat(e.target.value), e.target.closest('.part-slider-group'));
            });
        });

        // ±ステップボタン
        grid.querySelectorAll('.vol-step-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const track = this.tracks.find(t => t.id === btn.dataset.trackId);
                if (!track) return;
                const step = parseFloat(btn.dataset.step);
                _applyVolume(track, track.volume + step, btn.closest('.part-slider-group'));
            });
        });

        // Pan sliders
        grid.querySelectorAll('[data-param="pan"]').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const track = this.tracks.find(t => t.id === e.target.dataset.trackId);
                if (!track) return;
                track.pan = parseFloat(e.target.value);
                track.nodes.panNode.pan.setValueAtTime(track.pan, this.audioEngine.ctx.currentTime);
                const val = track.pan;
                e.target.closest('.part-slider-group').querySelector('.part-slider-value').textContent =
                    val === 0 ? '中央' : (val < 0 ? 'L' + Math.round(-val * 100) : 'R' + Math.round(val * 100));
            });
        });

        // Reverb sliders — 実際のリバーブノードに接続 ✅
        grid.querySelectorAll('[data-param="reverb"]').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const track = this.tracks.find(t => t.id === e.target.dataset.trackId);
                if (!track) return;
                const wet = parseInt(e.target.value) / 100; // 0〜1
                track._easyReverb = parseInt(e.target.value);

                // リバーブノードが存在する場合のみ適用
                if (track.nodes.reverbWet) {
                    const now = this.audioEngine.ctx.currentTime;
                    // wet増やしたぶんdryを減らしてトータル音量を保つ
                    track.nodes.reverbWet.gain.setValueAtTime(wet * 0.85, now);
                    track.nodes.reverbDry.gain.setValueAtTime(1.0 - wet * 0.5, now);
                }
                e.target.closest('.part-slider-group').querySelector('.part-slider-value').textContent = e.target.value + '%';
                this._updateChangeBadge(track);
            });
        });

        // Mute buttons
        grid.querySelectorAll('.btn-part-mute').forEach(btn => {
            btn.addEventListener('click', () => {
                const track = this.tracks.find(t => t.id === btn.dataset.trackId);
                if (!track) return;
                track.muted = !track.muted;
                track.nodes.gainNode.gain.value = track.muted ? 0 : track.volume;
                btn.classList.toggle('muted', track.muted);
                btn.querySelector('i').className = 'fas fa-' + (track.muted ? 'volume-mute' : 'volume-up');
                btn.closest('.part-card').classList.toggle('is-muted', track.muted);
            });
        });

        // Solo buttons
        grid.querySelectorAll('.btn-part-solo').forEach(btn => {
            btn.addEventListener('click', () => {
                const trackId = btn.dataset.trackId;
                const track = this.tracks.find(t => t.id === trackId);
                if (!track) return;

                track.solo = !track.solo;
                btn.classList.toggle('solo', track.solo);
                this._applySoloState();
                this._updateEasyCardsState();
            });
        });

        // M/Sボーカル除去スライダー（AI音楽モード専用・実際に変化が聴こえる）
        grid.querySelectorAll('.ms-vocal-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const track = this.tracks.find(t => t.id === e.target.dataset.trackId);
                if (!track) return;
                const pct = parseInt(e.target.value);
                track._msVocalReduction = pct;
                const valLabel = e.target.closest('.part-slider-group').querySelector('.ms-vocal-val');
                if (valLabel) valLabel.textContent = pct === 0 ? '変化なし' : pct + '% 除去中';
                this._applyVocalMS(track, pct);
                this._updateChangeBadge(track);
            });
        });

        // EQスライダー
        grid.querySelectorAll('.eq-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const track = this.tracks.find(t => t.id === e.target.dataset.trackId);
                if (!track) return;
                const band = e.target.dataset.eq; // low | mid | high
                const val  = parseInt(e.target.value);
                const now  = this.audioEngine.ctx.currentTime;

                if (band === 'low' && track.nodes.eqLow) {
                    track._eqLow = val;
                    track.nodes.eqLow.gain.setValueAtTime(val, now);
                } else if (band === 'mid' && track.nodes.eqMid) {
                    track._eqMid = val;
                    track.nodes.eqMid.gain.setValueAtTime(val, now);
                } else if (band === 'high' && track.nodes.eqHigh) {
                    track._eqHigh = val;
                    track.nodes.eqHigh.gain.setValueAtTime(val, now);
                }

                const lbl = grid.querySelector(`[data-eq-val="${track.id}-${band}"]`);
                if (lbl) lbl.textContent = val === 0 ? '±0' : (val > 0 ? '+' : '') + val + 'dB';

                // 値に応じてスライダーの色を変える
                const pct = ((val + 12) / 24 * 100).toFixed(0);
                e.target.style.setProperty('--eq-pct', pct + '%');
                e.target.dataset.positive = val > 0 ? '1' : '0';

                this._updateChangeBadge(track);
            });
        });

        // 5秒試聴ボタン
        grid.querySelectorAll('.btn-part-preview').forEach(btn => {
            btn.addEventListener('click', async () => {
                const track = this.tracks.find(t => t.id === btn.dataset.trackId);
                if (!track?.clips[0]?.buffer) return;

                await this.audioEngine.resume();

                // 既存の試聴を停止
                if (this._previewSource) {
                    try { this._previewSource.stop(); } catch(e) {}
                    this._previewSource = null;
                }

                btn.innerHTML = '<i class="fas fa-stop"></i>';
                btn.classList.add('previewing');

                const ctx = this.audioEngine.ctx;
                const src = ctx.createBufferSource();
                src.buffer = track.clips[0].buffer;
                src.connect(track.nodes.gainNode);

                // 曲の1/4あたりから5秒再生（サビに近い部分）
                const startOffset = Math.min(track.clips[0].buffer.duration * 0.25, 30);
                src.start(ctx.currentTime, startOffset, 5);
                this._previewSource = src;

                src.onended = () => {
                    btn.innerHTML = '<i class="fas fa-play"></i>';
                    btn.classList.remove('previewing');
                    this._previewSource = null;
                };

                // 5秒後に強制停止フォールバック
                setTimeout(() => {
                    if (this._previewSource === src) {
                        try { src.stop(); } catch(e) {}
                    }
                }, 5500);
            });
        });

        // レベルメーターのアニメーション
        this._startLevelMeters(grid);

        // 編集パネルのイベント
        this._setupEditPanelEvents(grid);
    }

    _startLevelMeters(grid) {
        // 既存のメーターRAFをすべてクリア（複数回呼ばれても安全）
        if (!this._meterRAF2List) this._meterRAF2List = [];
        this._meterRAF2List.forEach(id => cancelAnimationFrame(id));
        this._meterRAF2List = [];
        if (this._meterRAF2) { cancelAnimationFrame(this._meterRAF2); this._meterRAF2 = null; }

        const updateMeters = () => {
            const bars = grid.querySelectorAll('[data-meter-bar]');
            bars.forEach(bar => {
                const tid = bar.dataset.meterBar;
                const track = this.tracks.find(t => t.id === tid);
                if (!track?.nodes?.analyser) return;

                const data = new Uint8Array(track.nodes.analyser.frequencyBinCount);
                track.nodes.analyser.getByteFrequencyData(data);

                // RMSに近い平均を計算
                let sum = 0;
                for (let i = 0; i < data.length; i++) sum += data[i];
                const avg = sum / data.length / 255;

                const pct = Math.min(100, avg * 300); // 視認性のため感度を上げる
                bar.style.width = pct.toFixed(1) + '%';

                // 音量に応じて色を変える
                if (pct > 70) bar.style.background = '#e94560';
                else if (pct > 40) bar.style.background = '#eab308';
                else bar.style.background = '#22c55e';
            });

            // ループIDは1件だけ保持（pushしてリストを無限に増やさない）
            this._meterRAF2 = requestAnimationFrame(updateMeters);
        };
        this._meterRAF2 = requestAnimationFrame(updateMeters);
    }

    /** 秒を "0:00.0" 表示に変換 */
    _fmtSec(sec) {
        const s = parseFloat(sec);
        if (isNaN(s)) return '0:00.0';
        const m = Math.floor(s / 60);
        const r = (s % 60).toFixed(1).padStart(4, '0');
        return `${m}:${r}`;
    }

    _setupEditPanelEvents(grid) {
        // 動きFXボタン
        grid.querySelectorAll('.part-fx-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const track = this.tracks.find(t => t.id === btn.dataset.trackId);
                if (track) this._showEasyFxPanel(track, btn);
            });
        });

        // トグルボタン
        grid.querySelectorAll('.part-edit-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const tid = btn.dataset.trackId;
                const panel = grid.querySelector(`[data-edit-panel="${tid}"]`);
                const chevron = btn.querySelector('.part-edit-chevron');
                const isOpen = !panel.classList.contains('hidden');
                panel.classList.toggle('hidden', isOpen);
                chevron.style.transform = isOpen ? '' : 'rotate(180deg)';

                // パネルを開いたとき波形を描画
                if (!isOpen) {
                    const track = this.tracks.find(t => t.id === tid);
                    const canvas = grid.querySelector(`[data-edit-canvas="${tid}"]`);
                    if (canvas && track?.clips[0]?.buffer) {
                        canvas.width = canvas.offsetWidth || 400;
                        this.waveform.drawClipWaveform(canvas, track.clips[0].buffer, 0, track.clips[0].duration);
                        this._updateEditRangeBar(tid, track, grid);
                    }
                }
            });
        });

        // 編集スライダー
        grid.querySelectorAll('.edit-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const tid  = e.target.dataset.trackId;
                const key  = e.target.dataset.edit; // start|end|fadeIn|fadeOut
                const val  = parseFloat(e.target.value);
                const track = this.tracks.find(t => t.id === tid);
                if (!track) return;

                // 開始 < 終了 を維持
                if (key === 'start') {
                    const endSlider = grid.querySelector(`[data-edit="end"][data-track-id="${tid}"]`);
                    const endVal = parseFloat(endSlider?.value || track.clips[0]?.buffer?.duration || 30);
                    if (val >= endVal - 0.2) {
                        e.target.value = Math.max(0, endVal - 0.2);
                    }
                    track._editStart = parseFloat(e.target.value);
                } else if (key === 'end') {
                    const startSlider = grid.querySelector(`[data-edit="start"][data-track-id="${tid}"]`);
                    const startVal = parseFloat(startSlider?.value || 0);
                    if (val <= startVal + 0.2) {
                        e.target.value = startVal + 0.2;
                    }
                    track._editEnd = parseFloat(e.target.value);
                } else if (key === 'fadeIn') {
                    track._editFadeIn = val;
                } else if (key === 'fadeOut') {
                    track._editFadeOut = val;
                }

                // 値ラベル更新
                const lbl = grid.querySelector(`[data-edit-val="${tid}-${key}"]`);
                if (lbl) {
                    if (key === 'start' || key === 'end') {
                        lbl.textContent = this._fmtSec(e.target.value);
                    } else {
                        lbl.textContent = val === 0 ? 'なし' : `${val.toFixed(1)}秒`;
                    }
                }

                // レンジバー更新
                this._updateEditRangeBar(tid, track, grid);
            });
        });

        // 適用ボタン
        grid.querySelectorAll('.edit-apply-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tid   = btn.dataset.trackId;
                const track = this.tracks.find(t => t.id === tid);
                if (!track?.clips[0]?.buffer) return;

                const statusEl = grid.querySelector(`[data-edit-status="${tid}"]`);
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 処理中...';

                try {
                    // 初回適用時に元バッファを保存
                    if (!track._originalBuffer) {
                        track._originalBuffer = track.clips[0].buffer;
                    }

                    const dur = track._originalBuffer.duration;
                    const endVal = track._editEnd || dur;

                    const edited = this.creator.applyEdits(track._originalBuffer, {
                        startSec : track._editStart || 0,
                        endSec   : endVal,
                        fadeIn   : track._editFadeIn  || 0,
                        fadeOut  : track._editFadeOut || 0,
                    });

                    track.clips[0].buffer   = edited;
                    track.clips[0].duration = edited.duration;

                    // 波形を再描画（かんたんモード・上級者モード両方）
                    const miniCanvas = document.querySelector(`.part-waveform canvas[data-track-id="${tid}"]`);
                    if (miniCanvas) this.waveform.drawClipWaveform(miniCanvas, edited, 0, edited.duration);

                    const editCanvas = grid.querySelector(`[data-edit-canvas="${tid}"]`);
                    if (editCanvas) this.waveform.drawClipWaveform(editCanvas, edited, 0, edited.duration);

                    // 上級者モードのクリップ波形も更新
                    const clipEl = document.querySelector(`[data-clip-id="${track.clips[0].id}"]`);
                    if (clipEl) {
                        const clipCanvas = clipEl.querySelector('.clip-waveform');
                        if (clipCanvas) {
                            requestAnimationFrame(() => {
                                this.waveform.drawClipWaveform(clipCanvas, edited, 0, edited.duration, 1, track.clips[0]._gain || 1.0);
                            });
                        }
                    }

                    // 「元に戻す」ボタンを追加
                    const applyRow = btn.closest('.edit-apply-row');
                    if (!applyRow.querySelector('.edit-reset-btn')) {
                        const resetBtn = document.createElement('button');
                        resetBtn.className = 'edit-reset-btn';
                        resetBtn.dataset.trackId = tid;
                        resetBtn.innerHTML = '<i class="fas fa-undo"></i> 元に戻す';
                        resetBtn.addEventListener('click', () => this._resetEdit(tid, grid));
                        applyRow.insertBefore(resetBtn, statusEl);
                    }

                    if (statusEl) {
                        statusEl.textContent = '✅ 適用しました';
                        statusEl.style.color = 'var(--accent-green)';
                        setTimeout(() => { if(statusEl) statusEl.textContent = ''; }, 3000);
                    }
                } catch (err) {
                    if (statusEl) {
                        statusEl.textContent = '⚠️ ' + err.message;
                        statusEl.style.color = 'var(--accent)';
                    }
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-check"></i> 適用する';
                }
            });
        });

        // リセットボタン（元バッファがある場合のみ）
        grid.querySelectorAll('.edit-reset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._resetEdit(btn.dataset.trackId, grid);
            });
        });
    }

    _resetEdit(tid, grid) {
        const track = this.tracks.find(t => t.id === tid);
        if (!track?._originalBuffer) return;

        track.clips[0].buffer   = track._originalBuffer;
        track.clips[0].duration = track._originalBuffer.duration;
        track.clips[0]._saved   = false; // リセット後も再保存させる
        track._originalBuffer   = null;
        track._editStart = 0;
        track._editEnd   = track.clips[0].duration;
        track._editFadeIn  = 0;
        track._editFadeOut = 0;

        // 波形再描画
        const miniCanvas = document.querySelector(`.part-waveform canvas[data-track-id="${tid}"]`);
        if (miniCanvas) this.waveform.drawClipWaveform(miniCanvas, track.clips[0].buffer, 0, track.clips[0].duration);
        const editCanvas = grid.querySelector(`[data-edit-canvas="${tid}"]`);
        if (editCanvas) this.waveform.drawClipWaveform(editCanvas, track.clips[0].buffer, 0, track.clips[0].duration);

        // スライダーをリセット
        const dur = track.clips[0].duration;
        const startSlider = grid.querySelector(`[data-edit="start"][data-track-id="${tid}"]`);
        const endSlider   = grid.querySelector(`[data-edit="end"][data-track-id="${tid}"]`);
        const fiSlider    = grid.querySelector(`[data-edit="fadeIn"][data-track-id="${tid}"]`);
        const foSlider    = grid.querySelector(`[data-edit="fadeOut"][data-track-id="${tid}"]`);
        if (startSlider) { startSlider.max = dur.toFixed(1); startSlider.value = 0; }
        if (endSlider)   { endSlider.max   = dur.toFixed(1); endSlider.value   = dur.toFixed(1); }
        if (fiSlider)    fiSlider.value = 0;
        if (foSlider)    foSlider.value = 0;

        // ラベル更新
        const lblStart  = grid.querySelector(`[data-edit-val="${tid}-start"]`);
        const lblEnd    = grid.querySelector(`[data-edit-val="${tid}-end"]`);
        const lblFadeIn = grid.querySelector(`[data-edit-val="${tid}-fadeIn"]`);
        const lblFadeOut= grid.querySelector(`[data-edit-val="${tid}-fadeOut"]`);
        if (lblStart)   lblStart.textContent  = '0:00.0';
        if (lblEnd)     lblEnd.textContent    = this._fmtSec(dur);
        if (lblFadeIn)  lblFadeIn.textContent  = 'なし';
        if (lblFadeOut) lblFadeOut.textContent = 'なし';

        // リセットボタン自体を消す
        const resetBtn = grid.querySelector(`.edit-reset-btn[data-track-id="${tid}"]`);
        resetBtn?.remove();

        const statusEl = grid.querySelector(`[data-edit-status="${tid}"]`);
        if (statusEl) { statusEl.textContent = '↩️ 元に戻しました'; statusEl.style.color = 'var(--text-secondary)'; setTimeout(() => { statusEl.textContent = ''; }, 2500); }

        this._updateEditRangeBar(tid, track, grid);
    }

    _updateEditRangeBar(tid, track, grid) {
        const bar = grid.querySelector(`[data-range-bar="${tid}"]`);
        if (!bar || !track.clips[0]?.buffer) return;
        const dur   = track._originalBuffer?.duration || track.clips[0].buffer.duration;
        const start = (track._editStart || 0) / dur;
        const end   = (track._editEnd   || dur) / dur;
        bar.style.left  = (start * 100).toFixed(1) + '%';
        bar.style.width = ((end - start) * 100).toFixed(1) + '%';
    }

    /**
     * M/Sボーカル除去をデバウンスして適用する（800ms待ってから処理）
     * OfflineAudioContextで実際に音が変わる！
     */
    _applyVocalMS(track, reductionPct) {
        // 既存のタイマーをクリア
        if (track._msDebounceTimer) clearTimeout(track._msDebounceTimer);

        const statusEl = document.querySelector(`[data-ms-status="${track.id}"]`);

        if (reductionPct === 0) {
            // 0% → オリジナルに即時戻す
            if (track._msOriginalBuffer) {
                track.clips[0].buffer = track._msOriginalBuffer;
                if (this.audioEngine.isPlaying) {
                    const wasAt = this.audioEngine.getCurrentTime();
                    this.audioEngine.stop();
                    this.audioEngine.seek(wasAt);
                    this.audioEngine.play(this.tracks);
                }
                // 波形再描画
                const canvas = document.querySelector(`.part-waveform canvas[data-track-id="${track.id}"]`);
                if (canvas) this.waveform.drawClipWaveform(canvas, track._msOriginalBuffer, 0, track._msOriginalBuffer.duration);
            }
            if (statusEl) statusEl.textContent = '';
            return;
        }

        if (statusEl) statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 処理中...';

        track._msDebounceTimer = setTimeout(async () => {
            if (!track._msOriginalBuffer) return;
            const reduction = reductionPct / 100;
            try {
                const processed = await this.creator.removeVocalMidSide(track._msOriginalBuffer, reduction);
                track.clips[0].buffer = processed;

                // 再生中なら再起動
                if (this.audioEngine.isPlaying) {
                    this.audioEngine.play(this.tracks);
                }

                // 波形再描画
                const canvas = document.querySelector(`.part-waveform canvas[data-track-id="${track.id}"]`);
                if (canvas) this.waveform.drawClipWaveform(canvas, processed, 0, processed.duration);

                if (statusEl) {
                    statusEl.innerHTML = `✅ ボーカル帯域(200〜5.5kHz) ${reductionPct}% 除去済み（低音・高音は保持）`;
                    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
                }
            } catch (err) {
                if (statusEl) statusEl.textContent = '⚠️ エラー';
                console.error('M/S vocal error:', err);
            }
        }, 800);
    }

    /** 変化量（0〜100%）を計算する */
    _computeChangePct(track) {
        if (!track || track._isReference) return 0;
        const volDefault = 0.85;
        const volChange = Math.min(1, Math.abs((track.volume || volDefault) - volDefault) / volDefault);
        const eqChange = (Math.abs(track._eqLow || 0) + Math.abs(track._eqMid || 0) + Math.abs(track._eqHigh || 0)) / 36;
        const reverbChange = (track._easyReverb || 0) / 100;
        const vocalChange = (track._msVocalReduction || 0) / 100;
        return Math.min(100, Math.round((volChange + eqChange + reverbChange + vocalChange) / 4 * 100));
    }

    /** 変化量バッジを更新する */
    _updateChangeBadge(track) {
        const badge = document.querySelector(`[data-change-badge="${track.id}"]`);
        if (!badge) return;
        const pct = this._computeChangePct(track);
        badge.querySelector('.change-badge-val').textContent = pct + '%';
        const fill = badge.querySelector('.change-badge-fill');
        if (fill) fill.style.width = pct + '%';
        // 変化量に応じて色を変える
        badge.dataset.level = pct >= 50 ? 'high' : pct >= 15 ? 'mid' : 'low';
    }

    /** 全トラックの設定を初期状態（デフォルト）にリセットする */
    _resetAllToDefaults() {

        const now = this.audioEngine.ctx.currentTime;

        this.tracks.forEach(track => {
            if (!track.clips.length) return;

            // ボーカル除去のデバウンスタイマーをキャンセル（リセット後に上書きされるのを防ぐ）
            if (track._msDebounceTimer) {
                clearTimeout(track._msDebounceTimer);
                track._msDebounceTimer = null;
            }

            // オリジナルバッファを復元（バッファ編集・カット・ボーカル除去をすべて取り消し）
            const origBuf = track._msOriginalBuffer || track._originalBuffer || track._pristineBuffer;
            if (origBuf && track.clips[0]) {
                // 分割されたクリップを1つに戻し、元の音源・全長・ゲイン1.0へ
                const base = track.clips[0];
                track.clips = [{
                    id: base.id,
                    name: (base.name || 'クリップ').replace(/ \((前|後)\)$/, ''),
                    buffer: origBuf,
                    startTime: 0,
                    duration: origBuf.duration,
                    offset: 0,
                    _gain: 1.0,
                    _saved: false
                }];
            } else {
                // 元音源が無い場合でもゲイン・位置だけは初期化
                track.clips.forEach(c => { c._gain = 1.0; c.startTime = c.startTime; });
            }
            // FXクリップ（フィルタースウィープ等）をすべて削除
            track.fxClips = [];
            this._renderFxLane?.(track);

            // パラメータをデフォルト値にリセット
            track.volume  = 0.85;
            track.pan     = 0;
            track.muted   = false;
            track._eqLow  = 0;
            track._eqMid  = 0;
            track._eqHigh = 0;
            track._easyReverb        = 0;
            track._msVocalReduction  = 0;
            track._editStart = 0;
            track._editEnd   = track.clips[0]?.buffer?.duration || 0;
            track._editFadeIn  = 0;
            track._editFadeOut = 0;

            // Web Audio ノードに即座に反映
            if (!track.muted) track.nodes.gainNode.gain.setValueAtTime(0.85, now);
            track.nodes.panNode.pan.setValueAtTime(0, now);
            if (track.nodes.eqLow)  track.nodes.eqLow.gain.setValueAtTime(0, now);
            if (track.nodes.eqMid)  track.nodes.eqMid.gain.setValueAtTime(0, now);
            if (track.nodes.eqHigh) track.nodes.eqHigh.gain.setValueAtTime(0, now);
            if (track.nodes.reverbWet) {
                track.nodes.reverbWet.gain.setValueAtTime(0, now);
                track.nodes.reverbDry.gain.setValueAtTime(1, now);
            }

            // クリップDOMを作り直して見た目も初期状態に
            this._rerenderTrackClips(track);
            this._updateTrackHeader?.(track);
        });

        // マスターEQもリセット
        ['low', 'lowmid', 'mid', 'highmid', 'high'].forEach(band => {
            this.audioEngine.setMasterEQ(band, 0);
        });

        // BPMを元のBPMに戻す
        this.audioEngine.bpm = this.audioEngine.originalBpm || 120;
        this.audioEngine.bpmRatio = 1.0;
        const bpmInput = document.getElementById('bpm-input');
        if (bpmInput) bpmInput.value = this.audioEngine.bpm;

        // 再生中なら再起動して変更を反映
        if (this.audioEngine.isPlaying) {
            const wasAt = this.audioEngine.getCurrentTime();
            this.audioEngine.stop();
            this.audioEngine.seek(wasAt);
            this.audioEngine.play(this.tracks);
        }

        // マスターEQスライダーのUIも同期
        this._syncMasterEQSliders?.();

        // Undo/Redo履歴をクリア（初期化は元に戻せない区切り）
        this.undoStack = [];
        this.redoStack = [];
        this._updateUndoButtons();

        this._renderEasyCards();
        // 上級者モードのスライダーも同期
        this._syncAdvancedTrackHeaders();
        this._updateMixerUI();
        this._updateCanvasAreaWidths?.();
        this._saveProject?.();
        this._toast('✅ すべての編集を取り消し、当初の状態に戻しました（カット・フェード・EQ・音量・FX）', 'success');
    }

    async _clearProject() {
        if (!confirm('現在の曲データをすべて削除しますか？\n（この操作は元に戻せません）')) return;

        this.audioEngine.stop();

        // 全トラックを削除
        [...this.tracks].forEach(t => this.removeTrack(t.id));

        // IndexedDBのデータも削除
        if (this.storage) {
            try { await this.storage.clearAll(); } catch(e) {}
        }

        this._renderEasyCards();
        this._updateMixerUI();
        this._setStep(1);
        this._toast('曲データを削除しました。新しい曲をアップロードしてください。', 'info');
        this._updateStorageIndicator();
    }

    _updateEasyCardsState() {
        document.querySelectorAll('.part-card').forEach(card => {
            const track = this.tracks.find(t => t.id === card.dataset.trackId);
            if (!track) return;
            card.classList.toggle('is-muted', track.muted);
            const muteBtn = card.querySelector('.btn-part-mute');
            if (muteBtn) {
                muteBtn.classList.toggle('muted', track.muted);
                muteBtn.querySelector('i').className = 'fas fa-' + (track.muted ? 'volume-mute' : 'volume-up');
            }
        });
    }

    _getTrackEffectValue(track, param) {
        if (track._easyReverb !== undefined && param === 'reverb') return track._easyReverb;
        return 0;
    }

    _applyEasyPreset(preset) {
        // AI音楽モード（全体ミックス）用プリセット
        // EQはトラックのノードに直接、ボーカルはM/S処理で適用
        const presets = {
            'pop':       { eqLow:  1, eqMid:  1, eqHigh:  3, reverb:  5, vocalRemove:  0, volume: 0.85, masterEQ: { low: 1, lowmid: 0, mid: 1, highmid: 2, high: 3 }, stemVols: { vocals: 0.90, drums: 0.70, bass: 0.65, other: 0.60 }},
            'rock':      { eqLow:  3, eqMid:  0, eqHigh:  2, reverb: 10, vocalRemove:  0, volume: 0.90, masterEQ: { low: 3, lowmid: 1, mid: 0, highmid: 2, high: 2 }, stemVols: { vocals: 0.80, drums: 0.90, bass: 0.85, other: 0.75 }},
            'hiphop':    { eqLow:  6, eqMid: -1, eqHigh:  1, reverb:  8, vocalRemove:  0, volume: 0.90, masterEQ: { low: 5, lowmid: 2, mid: -1, highmid: 1, high: 1 }, stemVols: { vocals: 0.85, drums: 0.85, bass: 1.00, other: 0.50 }},
            'edm':       { eqLow:  5, eqMid: -1, eqHigh:  4, reverb: 20, vocalRemove:  0, volume: 0.90, masterEQ: { low: 4, lowmid: 0, mid: -1, highmid: 3, high: 4 }, stemVols: { vocals: 0.60, drums: 0.95, bass: 0.90, other: 0.80 }},
            'chill':     { eqLow:  2, eqMid:  0, eqHigh:  1, reverb: 30, vocalRemove:  0, volume: 0.80, masterEQ: { low: 2, lowmid: 1, mid: 0, highmid: -1, high: 1 }, stemVols: { vocals: 0.75, drums: 0.50, bass: 0.60, other: 0.70 }},
            'vocal-up':  { eqLow: -1, eqMid:  4, eqHigh:  2, reverb:  5, vocalRemove:  0, volume: 0.85, masterEQ: { low: -1, lowmid: 0, mid: 2, highmid: 3, high: 2 }, stemVols: { vocals: 1.20, drums: 0.50, bass: 0.50, other: 0.45 }},
            'bass-boost':{ eqLow:  8, eqMid: -1, eqHigh:  0, reverb:  5, vocalRemove:  0, volume: 0.85, masterEQ: { low: 6, lowmid: 3, mid: 0, highmid: 0, high: 0 }, stemVols: { vocals: 0.70, drums: 0.80, bass: 1.30, other: 0.60 }},
            'karaoke':   { eqLow:  0, eqMid:  0, eqHigh:  0, reverb: 15, vocalRemove: 75, volume: 0.85, masterEQ: { low: 0, lowmid: 0, mid: 0, highmid: 0, high: 0 }, stemVols: { vocals: 0.15, drums: 0.80, bass: 0.80, other: 0.80 }},
        };

        const p = presets[preset];
        if (!p) return;

        const now = this.audioEngine.ctx.currentTime;

        this.tracks.forEach(track => {
            if (track._isReference) return;

            // 音量（AIミックスは全体ボリューム、ステムモードはstem別）
            if (track._isAIMix) {
                track.volume = p.volume;
            } else {
                const stemMap = { 'ボーカル': 'vocals', 'ドラム': 'drums', 'ベース': 'bass', 'その他': 'other', 'メロディ': 'vocals', 'パッド': 'other' };
                let stemType = 'other';
                for (const [key, val] of Object.entries(stemMap)) {
                    if (track.name.includes(key)) { stemType = val; break; }
                }
                track.volume = (p.stemVols && p.stemVols[stemType]) ?? p.volume;
            }
            track.muted = false;
            track.nodes.gainNode.gain.setValueAtTime(track.volume, now);

            // EQ適用（実際にノードに反映）
            track._eqLow  = p.eqLow;
            track._eqMid  = p.eqMid;
            track._eqHigh = p.eqHigh;
            if (track.nodes.eqLow)  track.nodes.eqLow.gain.setValueAtTime(p.eqLow, now);
            if (track.nodes.eqMid)  track.nodes.eqMid.gain.setValueAtTime(p.eqMid, now);
            if (track.nodes.eqHigh) track.nodes.eqHigh.gain.setValueAtTime(p.eqHigh, now);

            // リバーブ適用
            track._easyReverb = p.reverb;
            const wet = p.reverb / 100;
            if (track.nodes.reverbWet) {
                track.nodes.reverbWet.gain.setValueAtTime(wet * 0.85, now);
                track.nodes.reverbDry.gain.setValueAtTime(1.0 - wet * 0.5, now);
            }

            // ボーカル除去（AI音楽モードのみ、M/S処理）
            if (track._isAIMix) {
                track._msVocalReduction = p.vocalRemove;
                this._applyVocalMS(track, p.vocalRemove);
            }
        });

        // マスターEQ適用
        if (p.masterEQ) {
            Object.entries(p.masterEQ).forEach(([band, val]) => {
                this.audioEngine.setMasterEQ(band, val);
            });
        }

        this._renderEasyCards();
        const presetNames = {
            'pop': 'ポップ・キラキラ', 'rock': 'ロック・パワフル', 'hiphop': 'ヒップホップ',
            'edm': 'EDM・クラブ', 'chill': 'チル・おだやか', 'vocal-up': 'ボーカル際立ち',
            'bass-boost': '重低音ブースト', 'karaoke': 'カラオケ風'
        };
        this._toast(`「${presetNames[preset]}」を適用しました！再生して確認してみてください`, 'success');
    }

    // ============================================
    // CORE TRACK MANAGEMENT
    // ============================================

    _addDefaultTracks() {
        for (let i = 0; i < 4; i++) {
            this.addTrack(`トラック ${i + 1}`);
        }
    }

    addTrack(name) {
        const id = 'track_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const nodes = this.audioEngine.createTrackNodes();
        const color = this.trackColors[this.tracks.length % this.trackColors.length];

        const track = {
            id,
            name: name || `トラック ${this.tracks.length + 1}`,
            color,
            clips: [],
            volume: 0.85,
            pan: 0,
            muted: false,
            solo: false,
            armed: false,
            nodes,
            effects: []
        };

        this.tracks.push(track);
        this.audioEngine.tracks = this.tracks;
        this._renderTrack(track);
        this._updateMixerUI();
        this._updateAutomationTrackSelect();
        return track;
    }

    removeTrack(trackId) {
        const idx = this.tracks.findIndex(t => t.id === trackId);
        if (idx < 0) return;
        this.tracks.splice(idx, 1);
        this.audioEngine.tracks = this.tracks;
        const el = document.querySelector(`[data-track-id="${trackId}"].track`);
        if (el) el.remove();
        this._updateMixerUI();
        this._updateAutomationTrackSelect();
    }

    async importAudio(file, targetTrackId) {
        this._showLoading('音声ファイルを読み込み中...');
        try {
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await this.audioEngine.decodeAudio(arrayBuffer);

            let track;
            if (targetTrackId) track = this.tracks.find(t => t.id === targetTrackId);
            if (!track) track = this.tracks.find(t => t.clips.length === 0);
            if (!track) track = this.addTrack(file.name.replace(/\.[^.]+$/, ''));

            const clip = {
                id: 'clip_' + Date.now(),
                name: file.name.replace(/\.[^.]+$/, ''),
                buffer: audioBuffer,
                startTime: 0,
                duration: audioBuffer.duration,
                offset: 0
            };

            track.clips.push(clip);
            track.name = clip.name;

            this._renderClip(track, clip);
            this._renderFxLane(track);
            this._updateTrackHeader(track);
            this._updateRuler();
            this._updateMixerUI();
            this._hideLoading();
            this._toast(`「${clip.name}」を読み込みました`, 'success');

            return { track, clip };
        } catch (err) {
            this._hideLoading();
            this._toast('ファイルの読み込みに失敗しました: ' + err.message, 'error');
            console.error(err);
        }
    }

    async importAndSeparate(file) {
        const songName = file.name.replace(/\.[^.]+$/, '');

        this._showLoading('音声ファイルを読み込み中...');
        let audioBuffer;
        try {
            const arrayBuffer = await file.arrayBuffer();
            audioBuffer = await this.audioEngine.decodeAudio(arrayBuffer);
        } catch (err) {
            this._hideLoading();
            this._toast('ファイルの読み込みに失敗しました: ' + err.message, 'error');
            return;
        }

        // 既存のトラックをすべてクリア
        [...this.tracks].forEach(t => this.removeTrack(t.id));

        // === AI音楽モード ===
        // SunoAI等のミックス済み楽曲を1トラックとして取り込む
        // ボーカル調整はM/S処理（実際に変化が聴こえる方式）

        // ① 編集用トラック（全体ミックス）
        const mixTrack = this.addTrack('🎵 ' + songName);
        mixTrack.color = '#4a9eff';
        mixTrack.volume = 0.85;
        mixTrack.nodes.gainNode.gain.value = 0.85;
        mixTrack._msOriginalBuffer = audioBuffer; // M/S処理の元データ保持用
        mixTrack._msVocalReduction = 0;
        mixTrack._isAIMix = true;

        // BPM自動検出（ロード後にUIを更新）
        try {
            const detectedBpm = this.creator.detectBpm(audioBuffer);
            this.audioEngine.originalBpm = detectedBpm;
            this.audioEngine.bpm = detectedBpm;
            this.audioEngine.bpmRatio = 1.0;
            const bpmInput = document.getElementById('bpm-input');
            if (bpmInput) bpmInput.value = detectedBpm;
        } catch(e) { /* BPM検出失敗は無視 */ }

        // キー(調)自動検出（読み取り専用・非同期で表示更新）
        this._detectAndShowKey(audioBuffer);

        const mixClip = {
            id: 'clip_mix_' + Date.now(),
            name: songName,
            buffer: audioBuffer,
            startTime: 0,
            duration: audioBuffer.duration,
            offset: 0
        };
        mixTrack.clips.push(mixClip);
        this._renderClip(mixTrack, mixClip);
        this._updateTrackHeader(mixTrack);

        // ② 原曲（ミュート済み・比較用）
        const origTrack = this.addTrack('🔇 原曲（比較用）');
        origTrack.color = '#6b7280';
        origTrack.muted = true;
        origTrack.nodes.gainNode.gain.value = 0;
        origTrack._isReference = true;

        const origClip = {
            id: 'clip_orig_' + Date.now(),
            name: songName + '（原曲）',
            buffer: audioBuffer,
            startTime: 0,
            duration: audioBuffer.duration,
            offset: 0
        };
        origTrack.clips.push(origClip);
        this._renderClip(origTrack, origClip);
        this._renderFxLane(origTrack);
        this._updateTrackHeader(origTrack);

        this._updateRuler();
        this._updateMixerUI();
        this._updateAutomationTrackSelect();
        this._hideLoading();

        if (this.easyMode) {
            this._renderEasyCards();
        }

        await this._saveProject();

        this._toast(
            `「${songName}」を読み込みました！スライダーで音量・音質・ボーカルを調整してみましょう。`,
            'success'
        );
    }

    async importMultipleForRemix(files) {
        this._showLoading('リミックス用ファイルを読み込み中...');
        try {
            for (const file of files) {
                const arrayBuffer = await file.arrayBuffer();
                const audioBuffer = await this.audioEngine.decodeAudio(arrayBuffer);
                const name = file.name.replace(/\.[^.]+$/, '');
                this.remix.addSong(name, audioBuffer);
            }
            this._updateRemixUI();
            this._hideLoading();
            this._toast(`${files.length}曲をリミックスに追加しました`, 'success');
            if (!this.easyMode) document.querySelector('[data-panel="remix"]').click();
        } catch (err) {
            this._hideLoading();
            this._toast('読み込みエラー: ' + err.message, 'error');
        }
    }

    // ============================================
    // TRACK RENDERING (Advanced mode)
    // ============================================

    _renderTrack(track) {
        const container = document.getElementById('tracks-container');
        const div = document.createElement('div');
        div.className = 'track';
        div.dataset.trackId = track.id;

        div.innerHTML = `
            <div class="track-color" style="background: ${escapeHtml(track.color)}"></div>
            <div class="track-header">
                <div class="track-header-top">
                    <input class="track-name" value="${escapeHtml(track.name)}" data-track-id="${escapeHtml(track.id)}">
                </div>
                <div class="track-controls">
                    <button class="btn-mute" data-track-id="${track.id}" title="ミュート">M</button>
                    <button class="btn-solo" data-track-id="${track.id}" title="ソロ">S</button>
                    <button class="btn-arm" data-track-id="${track.id}" title="録音準備">R</button>
                    <button class="btn-remove-track" data-track-id="${track.id}" title="削除"><i class="fas fa-trash"></i></button>
                </div>
                <div class="track-volume">
                    <i class="fas fa-volume-up" style="font-size:10px;color:var(--text-muted)"></i>
                    <input type="range" class="track-vol-slider" data-track-id="${track.id}" min="0" max="1.5" step="0.01" value="${track.volume}">
                    <span class="track-volume-label">${Math.round(track.volume * 100)}%</span>
                </div>
                <div class="track-pan">
                    <span>L</span>
                    <input type="range" class="track-pan-slider" data-track-id="${track.id}" min="-1" max="1" step="0.01" value="${track.pan}">
                    <span>R</span>
                </div>
            </div>
            <div class="track-canvas-area" data-track-id="${track.id}">
                <canvas class="track-waveform-canvas"></canvas>
            </div>
        `;

        container.appendChild(div);
        this._setupTrackEvents(div, track);
    }

    _setupTrackEvents(div, track) {
        div.querySelector('.btn-mute').addEventListener('click', () => {
            track.muted = !track.muted;
            div.querySelector('.btn-mute').classList.toggle('active-mute', track.muted);
            track.nodes.gainNode.gain.value = track.muted ? 0 : track.volume;
            this._updateMixerUI();
        });

        div.querySelector('.btn-solo').addEventListener('click', () => {
            track.solo = !track.solo;
            div.querySelector('.btn-solo').classList.toggle('active-solo', track.solo);
            this._applySoloState();
            this._updateMixerUI();
        });

        div.querySelector('.btn-arm').addEventListener('click', () => {
            track.armed = !track.armed;
            div.querySelector('.btn-arm').classList.toggle('active-record', track.armed);
        });

        div.querySelector('.btn-remove-track').addEventListener('click', () => this.removeTrack(track.id));

        div.querySelector('.track-vol-slider').addEventListener('input', (e) => {
            track.volume = parseFloat(e.target.value);
            if (!track.muted) track.nodes.gainNode.gain.setValueAtTime(track.volume, this.audioEngine.ctx.currentTime);
            div.querySelector('.track-volume-label').textContent = Math.round(track.volume * 100) + '%';
        });

        div.querySelector('.track-pan-slider').addEventListener('input', (e) => {
            track.pan = parseFloat(e.target.value);
            track.nodes.panNode.pan.setValueAtTime(track.pan, this.audioEngine.ctx.currentTime);
        });

        div.querySelector('.track-name').addEventListener('change', (e) => {
            track.name = e.target.value;
            this._updateMixerUI();
        });

        const canvasArea = div.querySelector('.track-canvas-area');
        canvasArea.addEventListener('click', (e) => {
            this.selectedTrack = track;
            document.querySelectorAll('.track').forEach(t => t.style.outline = 'none');
            div.style.outline = '1px solid var(--accent-secondary)';
            this._updatePropertiesPanel(track);
            this._updateEffectsPanel(track);
        });
    }

    _renderClip(track, clip) {
        const trackDiv = document.querySelector(`[data-track-id="${track.id}"].track`);
        if (!trackDiv) return;
        const canvasArea = trackDiv.querySelector('.track-canvas-area');
        const existingClip = canvasArea.querySelector(`[data-clip-id="${clip.id}"]`);
        if (existingClip) existingClip.remove();

        const clipDiv = document.createElement('div');
        clipDiv.className = 'clip';
        clipDiv.dataset.clipId = clip.id;
        clipDiv.style.left = (clip.startTime * this.pixelsPerSecond) + 'px';
        clipDiv.style.width = (clip.duration * this.pixelsPerSecond) + 'px';
        clipDiv.style.borderColor = track.color;

        const clipCanvas = document.createElement('canvas');
        clipCanvas.className = 'clip-waveform';
        const label = document.createElement('span');
        label.className = 'clip-label';
        label.textContent = clip.name;
        const handleL = document.createElement('div');
        handleL.className = 'clip-handle clip-handle-left';
        const handleR = document.createElement('div');
        handleR.className = 'clip-handle clip-handle-right';

        clipDiv.appendChild(clipCanvas);
        clipDiv.appendChild(label);
        clipDiv.appendChild(handleL);
        clipDiv.appendChild(handleR);

        clipDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectedClip = clip;
            this.selectedTrack = track;
            document.querySelectorAll('.clip').forEach(c => c.classList.remove('selected'));
            clipDiv.classList.add('selected');
            this._updatePropertiesPanel(track, clip);
        });

        this._setupClipDrag(clipDiv, track, clip);
        canvasArea.appendChild(clipDiv);

        // 描画: width>0 になるまで最大20回リトライ（display:none / 背景タブ対策）
        // フォールバック付きで即描画 + 遅延で再描画（display:none 親対策）
        const _drawClip = () => {
            this.waveform.drawClipWaveform(clipCanvas, clip.buffer, clip.offset || 0, clip.duration);
        };
        setTimeout(_drawClip, 0);
        setTimeout(_drawClip, 300);
        this._updateCanvasAreaWidths();
    }

    _setupClipDrag(clipDiv, track, clip) {
        // クリップゲイン初期化
        if (clip._gain === undefined) clip._gain = 1.0;

        // ゲインオーバーレイ（縦ドラッグ中に表示）
        const gainOverlay = document.createElement('div');
        gainOverlay.className = 'clip-gain-overlay';
        gainOverlay.style.display = 'none';
        clipDiv.appendChild(gainOverlay);

        // ゲイン値を gainNode に反映
        const _applyGain = () => {
            if (track.nodes?.gainNode && !track.muted) {
                track.nodes.gainNode.gain.setValueAtTime(
                    track.volume * clip._gain,
                    this.audioEngine.ctx?.currentTime || 0
                );
            }
        };

        // 波形をゲイン反映して再描画
        const _redrawWithGain = () => {
            const canvas = clipDiv.querySelector('.clip-waveform');
            if (canvas && clip.buffer) {
                this.waveform.drawClipWaveform(canvas, clip.buffer, clip.offset || 0, clip.duration, 1, clip._gain);
            }
        };

        // ── 横移動 / 縦ドラッグ（ゲイン調整） ──────────────────
        let isDragging = false, startX = 0, startY = 0, originalLeft = 0;
        let dragMode = null; // 'horizontal' | 'vertical' | null
        let startGain = 1.0;

        clipDiv.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('clip-handle')) return;
            if (this.currentTool === 'cut') { this._cutClip(track, clip, e); return; }
            isDragging = true;
            dragMode = null;
            startX = e.clientX;
            startY = e.clientY;
            startGain = clip._gain;
            originalLeft = parseFloat(clipDiv.style.left) || 0;
            this._dragStartState = this._captureState(); // ドラッグ前状態（Undo用）
            e.preventDefault();
        });

        const _onMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            // 5px動いたらドラッグモードを確定
            if (!dragMode && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                dragMode = Math.abs(dy) > Math.abs(dx) ? 'vertical' : 'horizontal';
            }

            if (dragMode === 'horizontal') {
                // 横移動 = タイムライン上での位置変更
                const newLeft = Math.max(0, originalLeft + dx);
                clipDiv.style.left = newLeft + 'px';
                clip.startTime = newLeft / this.pixelsPerSecond;
                gainOverlay.style.display = 'none';

            } else if (dragMode === 'vertical') {
                // 縦移動 = ゲイン調整（100px = ×2倍 / ÷2倍）
                // 上にドラッグ → dy < 0 → ゲイン増加
                const gainFactor = Math.pow(2, -dy / 100);
                clip._gain = Math.max(0.05, Math.min(4.0, startGain * gainFactor));
                _applyGain();

                // dB表示
                const db = 20 * Math.log10(clip._gain);
                const sign = db >= 0 ? '+' : '';
                gainOverlay.textContent = `${sign}${db.toFixed(1)} dB`;
                gainOverlay.style.display = 'block';
                gainOverlay.style.color = clip._gain > 1.5 ? '#e94560' : '#fff';

                // 波形を即時更新（スロットリング）
                if (!this._gainRedrawTimer) {
                    this._gainRedrawTimer = requestAnimationFrame(() => {
                        _redrawWithGain();
                        this._gainRedrawTimer = null;
                    });
                }
            }
        };

        const _onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            gainOverlay.style.display = 'none';
            if (dragMode === 'vertical' || dragMode === 'horizontal') {
                // 実際に編集が起きた場合のみUndo記録
                if (this._dragStartState) this._pushUndo(this._dragStartState);
                if (dragMode === 'vertical') _redrawWithGain();
                this._saveProject?.();
            }
            this._dragStartState = null;
            dragMode = null;
        };

        document.addEventListener('mousemove', _onMouseMove);
        document.addEventListener('mouseup', _onMouseUp);

        // ダブルクリックでゲインをリセット
        clipDiv.addEventListener('dblclick', (e) => {
            if (e.target.classList.contains('clip-handle')) return;
            if (dragMode) return;
            clip._gain = 1.0;
            _applyGain();
            _redrawWithGain();
            this._toast('クリップゲインをリセットしました', 'info');
        });

        // ── リサイズハンドル ──────────────────────────────────
        let isResizing = false, resizeSide = '', resizeStartX = 0, originalWidth = 0;
        const startResize = (side) => (e) => {
            isResizing = true; resizeSide = side; resizeStartX = e.clientX;
            originalLeft = parseFloat(clipDiv.style.left) || 0;
            originalWidth = parseFloat(clipDiv.style.width) || 0;
            e.stopPropagation(); e.preventDefault();
        };

        clipDiv.querySelector('.clip-handle-left').addEventListener('mousedown', startResize('left'));
        clipDiv.querySelector('.clip-handle-right').addEventListener('mousedown', startResize('right'));

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const dx = e.clientX - resizeStartX;
            if (resizeSide === 'right') {
                clipDiv.style.width = Math.max(20, originalWidth + dx) + 'px';
                clip.duration = Math.max(20, originalWidth + dx) / this.pixelsPerSecond;
            } else {
                const newLeft = Math.max(0, originalLeft + dx);
                const newWidth = Math.max(20, originalWidth - dx);
                clipDiv.style.left = newLeft + 'px';
                clipDiv.style.width = newWidth + 'px';
                clip.startTime = newLeft / this.pixelsPerSecond;
                clip.duration = newWidth / this.pixelsPerSecond;
            }
        });
        document.addEventListener('mouseup', () => { isResizing = false; });
    }

    // マスタリングパネルのEQスライダー表示をエンジンの現在値に同期する
    _syncMasterEQSliders() {
        document.querySelectorAll('.master-eq').forEach(slider => {
            const band = slider.dataset.band;
            const filter = this.audioEngine.masterEQ?.[band];
            if (!filter) return;
            const val = filter.gain.value;
            slider.value = val;
            const label = slider.closest('.eq-band')?.querySelector('.eq-value');
            if (label) label.textContent = val + ' dB';
        });
    }

    // ── 自動ゼロクロス点検出 ──────────────────────────────
    // バッファ内 targetSec 周辺で振幅が0（符号反転）に最も近いタイミングを探し、
    // その時刻（秒）を返す。プチプチノイズ（クリックノイズ）を防ぐ。
    // bufferOffsetSec : clip.offset を加味したバッファ内の絶対秒数で探索する
    _findZeroCrossing(buffer, bufferTargetSec, searchRangeSec = 0.03) {
        if (!buffer) return bufferTargetSec;
        const data = buffer.getChannelData(0);
        const sr = buffer.sampleRate;
        const targetSample = Math.round(bufferTargetSec * sr);
        const range = Math.round(searchRangeSec * sr);
        const lo = Math.max(1, targetSample - range);
        const hi = Math.min(data.length - 1, targetSample + range);

        let bestSample = -1;
        let bestDist = Infinity;
        // 符号反転（ゼロクロス）を探し、targetに最も近いものを採用
        for (let i = lo; i <= hi; i++) {
            const prev = data[i - 1];
            const cur = data[i];
            if ((prev <= 0 && cur > 0) || (prev >= 0 && cur < 0) || cur === 0) {
                const dist = Math.abs(i - targetSample);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestSample = i;
                }
            }
        }
        // 見つからなければ元の位置を返す
        if (bestSample < 0) return bufferTargetSec;
        return bestSample / sr;
    }

    _cutClip(track, clip, event) {
        const trackDiv = document.querySelector(`[data-track-id="${track.id}"].track`);
        const canvasArea = trackDiv.querySelector('.track-canvas-area');
        const rect = canvasArea.getBoundingClientRect();
        let cutTime = (event.clientX - rect.left) / this.pixelsPerSecond;
        if (cutTime <= clip.startTime || cutTime >= clip.startTime + clip.duration) return;

        // ▼ 自動ゼロクロス点検出：クリック位置をバッファ内座標に変換し補正
        const clipOffset = clip.offset || 0;
        const bufferTargetSec = clipOffset + (cutTime - clip.startTime);
        const zcBufferSec = this._findZeroCrossing(clip.buffer, bufferTargetSec);
        // 補正分をタイムライン座標に反映
        cutTime = clip.startTime + (zcBufferSec - clipOffset);

        // 分割前の状態をUndoスタックへ
        if (!track._pristineBuffer) track._pristineBuffer = clip.buffer;
        this._pushUndo();

        const relCut = cutTime - clip.startTime;
        const clip1 = { id: 'clip_' + Date.now() + '_a', name: clip.name + ' (前)', buffer: clip.buffer, startTime: clip.startTime, duration: relCut, offset: clip.offset || 0 };
        const clip2 = { id: 'clip_' + Date.now() + '_b', name: clip.name + ' (後)', buffer: clip.buffer, startTime: cutTime, duration: clip.duration - relCut, offset: (clip.offset || 0) + relCut };

        const idx = track.clips.indexOf(clip);
        track.clips.splice(idx, 1, clip1, clip2);

        const oldClipDiv = canvasArea.querySelector(`[data-clip-id="${clip.id}"]`);
        if (oldClipDiv) oldClipDiv.remove();
        this._renderClip(track, clip1);
        this._renderClip(track, clip2);
        this._toast('クリップを分割しました（ゼロクロス点で自動補正・ノイズ防止）', 'success');
    }

    _updateTrackHeader(track) {
        const div = document.querySelector(`[data-track-id="${track.id}"].track`);
        if (!div) return;
        const nameInput = div.querySelector('.track-name');
        if (nameInput) nameInput.value = track.name;
    }

    _updatePlayhead(time) {
        const playhead = document.getElementById('playhead');
        const container = document.getElementById('tracks-container');
        const trackArea = document.getElementById('track-area');
        const trackHeaderWidth = 180;

        const viewWidth = trackArea.offsetWidth - trackHeaderWidth;
        const playheadInContent = time * this.pixelsPerSecond;

        if (this.audioEngine.isPlaying) {
            const visibleStart = container.scrollLeft;
            const visibleEnd = visibleStart + viewWidth;
            if (playheadInContent > visibleEnd - 80) container.scrollLeft = playheadInContent - 80;
            else if (playheadInContent < visibleStart) container.scrollLeft = playheadInContent;
        }

        this.scrollOffset = container.scrollLeft;
        playhead.style.left = (trackHeaderWidth + playheadInContent - this.scrollOffset) + 'px';
        document.getElementById('current-time').textContent = this._formatTime(time);

        let maxDuration = 0;
        this.tracks.forEach(t => t.clips.forEach(c => {
            const end = (c.startTime || 0) + c.duration;
            if (end > maxDuration) maxDuration = end;
        }));
        document.getElementById('total-time').textContent = this._formatTime(maxDuration);
    }

    _updateCanvasAreaWidths() {
        let maxEnd = 30;
        this.tracks.forEach(t => t.clips.forEach(c => {
            const end = (c.startTime || 0) + c.duration;
            if (end > maxEnd) maxEnd = end;
        }));
        const canvasMinWidth = (maxEnd + 10) * this.pixelsPerSecond;
        document.querySelectorAll('.track-canvas-area').forEach(el => el.style.minWidth = canvasMinWidth + 'px');
    }

    // ════════════════════════════════════════════════════════════
    //  FX クリップシステム（スウィープ・動きエフェクト）
    // ════════════════════════════════════════════════════════════

    /** FX プリセット定義 */
    get _fxPresets() {
        return [
            { id: 'filter-up',    label: 'フィルター↑',  icon: '🔺', color: '#6366f1', desc: '低音から高音へ開くスウィープ' },
            { id: 'filter-down',  label: 'フィルター↓',  icon: '🔻', color: '#8b5cf6', desc: '高音から低音へ閉じるスウィープ' },
            { id: 'volume-rise',  label: '音量ライズ',   icon: '📈', color: '#22c55e', desc: '無音から徐々にフェードイン' },
            { id: 'volume-fall',  label: '音量フォール', icon: '📉', color: '#ef4444', desc: '徐々にフェードアウト' },
            { id: 'pan-lr',       label: 'パン L→R',    icon: '◀▶', color: '#f59e0b', desc: '左から右へパン移動' },
            { id: 'pan-rl',       label: 'パン R→L',    icon: '▶◀', color: '#f59e0b', desc: '右から左へパン移動' },
            { id: 'wobble',       label: 'ウォブル',     icon: '〜',  color: '#ec4899', desc: 'ガクガク音量揺れ（LFO）' },
            { id: 'rise-build',   label: 'ライズビルド', icon: '🚀', color: '#06b6d4', desc: 'フィルター＋音量を同時にライズ（盛り上がり）' },
        ];
    }

    /** FXクリップのスケジューリング（再生時に呼ぶ） */
    _scheduleAllFxClips() {
        const ctx = this.audioEngine.ctx;
        if (!ctx) return;
        const offset   = this.audioEngine.pauseTime;
        const wallStart = this.audioEngine.startTime;
        const ratio    = this.audioEngine.bpmRatio || 1.0;

        // まず全トラックの自動化パラメーターをリセット
        this.tracks.forEach(track => {
            const n = track.nodes;
            if (!n) return;
            n.gainNode.gain.cancelScheduledValues(ctx.currentTime);
            n.gainNode.gain.setValueAtTime(track.muted ? 0 : track.volume, ctx.currentTime);
            n.panNode.pan.cancelScheduledValues(ctx.currentTime);
            n.panNode.pan.setValueAtTime(track.pan, ctx.currentTime);
            if (n.sweepFilter) {
                n.sweepFilter.frequency.cancelScheduledValues(ctx.currentTime);
                n.sweepFilter.frequency.setValueAtTime(22050, ctx.currentTime);
            }
        });

        this.tracks.forEach(track => {
            if (!track.fxClips?.length) return;
            const n = track.nodes;
            if (!n) return;

            track.fxClips.forEach(fx => {
                const fxStart = fx.startTime;
                const fxEnd   = fxStart + fx.duration;

                // 現在位置より前に終わるFXはスキップ
                if (fxEnd <= offset) return;

                // Wall-clock の開始・終了時刻
                const wallFxStart = wallStart + Math.max(0, fxStart - offset) / ratio;
                const wallFxEnd   = wallStart + Math.max(0, fxEnd   - offset) / ratio;

                const baseVol = track.muted ? 0 : (track.volume * (track.clips[0]?._gain || 1));

                switch (fx.type) {
                    case 'filter-up':
                        n.sweepFilter.frequency.setValueAtTime(80, wallFxStart);
                        n.sweepFilter.frequency.exponentialRampToValueAtTime(22050, wallFxEnd);
                        break;
                    case 'filter-down':
                        n.sweepFilter.frequency.setValueAtTime(22050, wallFxStart);
                        n.sweepFilter.frequency.exponentialRampToValueAtTime(80, wallFxEnd);
                        // 終了後にリセット
                        n.sweepFilter.frequency.setValueAtTime(22050, wallFxEnd + 0.01);
                        break;
                    case 'volume-rise':
                        n.gainNode.gain.setValueAtTime(0.001, wallFxStart);
                        n.gainNode.gain.linearRampToValueAtTime(baseVol, wallFxEnd);
                        break;
                    case 'volume-fall':
                        n.gainNode.gain.setValueAtTime(baseVol, wallFxStart);
                        n.gainNode.gain.linearRampToValueAtTime(0.001, wallFxEnd);
                        n.gainNode.gain.setValueAtTime(baseVol, wallFxEnd + 0.01);
                        break;
                    case 'pan-lr':
                        n.panNode.pan.setValueAtTime(-1, wallFxStart);
                        n.panNode.pan.linearRampToValueAtTime(1, wallFxEnd);
                        n.panNode.pan.setValueAtTime(track.pan, wallFxEnd + 0.01);
                        break;
                    case 'pan-rl':
                        n.panNode.pan.setValueAtTime(1, wallFxStart);
                        n.panNode.pan.linearRampToValueAtTime(-1, wallFxEnd);
                        n.panNode.pan.setValueAtTime(track.pan, wallFxEnd + 0.01);
                        break;
                    case 'wobble': {
                        // 16分音符ごとに音量を上下（LFO的）
                        const steps = Math.ceil(fx.duration * 8);
                        for (let i = 0; i <= steps; i++) {
                            const t = wallFxStart + (i / steps) * (wallFxEnd - wallFxStart);
                            const v = i % 2 === 0 ? baseVol : baseVol * 0.3;
                            n.gainNode.gain.setValueAtTime(v, t);
                        }
                        n.gainNode.gain.setValueAtTime(baseVol, wallFxEnd + 0.01);
                        break;
                    }
                    case 'rise-build':
                        n.sweepFilter.frequency.setValueAtTime(80, wallFxStart);
                        n.sweepFilter.frequency.exponentialRampToValueAtTime(22050, wallFxEnd);
                        n.gainNode.gain.setValueAtTime(0.001, wallFxStart);
                        n.gainNode.gain.linearRampToValueAtTime(baseVol, wallFxEnd);
                        break;
                }
            });
        });
    }

    /** FXクリップをトラックに追加 */
    _addFxClip(track, type, startTime, duration) {
        if (!track.fxClips) track.fxClips = [];
        const fx = {
            id: 'fx_' + Date.now(),
            type,
            startTime: Math.max(0, startTime),
            duration: Math.max(0.5, duration),
        };
        track.fxClips.push(fx);
        this._renderFxLane(track);
        this._saveProject();
        return fx;
    }

    /** FXクリップを削除 */
    _removeFxClip(track, fxId) {
        if (!track.fxClips) return;
        track.fxClips = track.fxClips.filter(f => f.id !== fxId);
        this._renderFxLane(track);
        this._saveProject();
    }

    /** 上級者モードのFXレーンを描画（各トラックのcanvasAreaの下） */
    _renderFxLane(track) {
        const trackDiv = document.querySelector(`[data-track-id="${track.id}"].track`);
        if (!trackDiv) return;

        let lane = trackDiv.querySelector('.fx-lane');
        if (!lane) {
            lane = document.createElement('div');
            lane.className = 'fx-lane';
            trackDiv.querySelector('.track-canvas-area').after(lane);
        }

        lane.innerHTML = '';
        lane.style.position = 'relative';

        (track.fxClips || []).forEach(fx => {
            const preset = this._fxPresets.find(p => p.id === fx.type);
            if (!preset) return;

            const block = document.createElement('div');
            block.className = 'fx-clip';
            block.style.left    = (fx.startTime * this.pixelsPerSecond) + 'px';
            block.style.width   = (fx.duration  * this.pixelsPerSecond) + 'px';
            block.style.background = preset.color + 'cc';
            block.style.borderColor = preset.color;
            block.title = `${preset.icon} ${preset.label}（ダブルクリックで削除）`;
            block.innerHTML = `<span class="fx-clip-label">${preset.icon} ${preset.label}</span>`;

            // 右端リサイズハンドル
            const resizeHandle = document.createElement('div');
            resizeHandle.className = 'fx-clip-resize';
            block.appendChild(resizeHandle);

            // ドラッグで位置移動
            let dragging = false, startX = 0, origLeft = 0;
            block.addEventListener('mousedown', (e) => {
                if (e.target === resizeHandle) return;
                dragging = true; startX = e.clientX;
                origLeft = fx.startTime * this.pixelsPerSecond;
                e.preventDefault(); e.stopPropagation();
            });
            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const newLeft = Math.max(0, origLeft + (e.clientX - startX));
                fx.startTime = newLeft / this.pixelsPerSecond;
                block.style.left = newLeft + 'px';
            });
            document.addEventListener('mouseup', () => {
                if (dragging) { dragging = false; this._saveProject(); }
            });

            // リサイズハンドルで長さ変更
            let resizing = false, rsX = 0, origW = 0;
            resizeHandle.addEventListener('mousedown', (e) => {
                resizing = true; rsX = e.clientX;
                origW = fx.duration * this.pixelsPerSecond;
                e.preventDefault(); e.stopPropagation();
            });
            document.addEventListener('mousemove', (e) => {
                if (!resizing) return;
                const newW = Math.max(20, origW + (e.clientX - rsX));
                fx.duration = newW / this.pixelsPerSecond;
                block.style.width = newW + 'px';
            });
            document.addEventListener('mouseup', () => {
                if (resizing) { resizing = false; this._saveProject(); }
            });

            // ダブルクリックで削除
            block.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                this._removeFxClip(track, fx.id);
            });

            lane.appendChild(block);
        });

        // 空レーン上でクリック → FX選択メニュー
        lane.addEventListener('click', (e) => {
            if (e.target !== lane) return;
            const clickTime = (e.offsetX) / this.pixelsPerSecond;
            this._showFxPickerAt(track, clickTime, lane);
        });
    }

    /** FXピッカーポップアップを表示 */
    _showFxPickerAt(track, clickTime, anchorEl) {
        document.querySelectorAll('.fx-picker-popup').forEach(p => p.remove());

        const popup = document.createElement('div');
        popup.className = 'fx-picker-popup';
        popup.innerHTML = `<div class="fx-picker-title">＋ FXを追加 @ ${this._fmtSec(clickTime)}</div>`;

        this._fxPresets.forEach(preset => {
            const btn = document.createElement('button');
            btn.className = 'fx-picker-btn';
            btn.style.borderLeftColor = preset.color;
            btn.innerHTML = `<span class="fx-picker-icon">${preset.icon}</span>
                <span class="fx-picker-info">
                    <b>${preset.label}</b>
                    <small>${preset.desc}</small>
                </span>`;
            btn.addEventListener('click', () => {
                this._addFxClip(track, preset.id, clickTime, 4);
                popup.remove();
                this._toast(`${preset.icon} ${preset.label} を追加しました`, 'success');
            });
            popup.appendChild(btn);
        });

        const closeBtn = document.createElement('button');
        closeBtn.className = 'fx-picker-close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', () => popup.remove());
        popup.appendChild(closeBtn);

        document.body.appendChild(popup);

        // アンカー位置に表示
        const r = anchorEl.getBoundingClientRect();
        popup.style.top  = (r.bottom + window.scrollY) + 'px';
        popup.style.left = Math.min(r.left + window.scrollX, window.innerWidth - 320) + 'px';

        setTimeout(() => document.addEventListener('click', function dismiss(ev) {
            if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', dismiss); }
        }), 100);
    }

    /** かんたんモードのFXクイックパネルを表示 */
    _showEasyFxPanel(track, anchorEl) {
        document.querySelectorAll('.easy-fx-popup').forEach(p => p.remove());

        const totalDur = track.clips[0]?.buffer?.duration || 60;
        const popup = document.createElement('div');
        popup.className = 'easy-fx-popup';

        popup.innerHTML = `
            <div class="easy-fx-title">🎛 動きFX — ${escapeHtml(track.name)}</div>
            <div class="easy-fx-presets">
                ${this._fxPresets.map(p =>
                    `<button class="easy-fx-preset-btn" data-fx="${p.id}"
                        style="border-color:${p.color};color:${p.color}"
                        title="${p.desc}">
                        ${p.icon} ${p.label}
                    </button>`
                ).join('')}
            </div>
            <div class="easy-fx-controls">
                <label>開始位置 <span id="efx-pos-val">0秒</span></label>
                <input type="range" id="efx-pos" min="0" max="${(totalDur * 0.9).toFixed(1)}" step="0.1" value="0">
                <label>長さ <span id="efx-dur-val">4秒</span></label>
                <input type="range" id="efx-dur" min="0.5" max="${Math.min(30, totalDur).toFixed(1)}" step="0.5" value="4">
            </div>
            <div class="easy-fx-list" id="efx-list"></div>
            <button class="easy-fx-close">✕ 閉じる</button>
        `;
        document.body.appendChild(popup);

        // アンカー位置
        const r = anchorEl.getBoundingClientRect();
        popup.style.top  = (r.bottom + window.scrollY + 4) + 'px';
        popup.style.left = Math.min(r.left + window.scrollX, window.innerWidth - 340) + 'px';

        const posSlider = popup.querySelector('#efx-pos');
        const durSlider = popup.querySelector('#efx-dur');
        const posVal    = popup.querySelector('#efx-pos-val');
        const durVal    = popup.querySelector('#efx-dur-val');
        const list      = popup.querySelector('#efx-list');

        const _refreshList = () => {
            list.innerHTML = (track.fxClips || []).map(fx => {
                const p = this._fxPresets.find(x => x.id === fx.type);
                return `<div class="efx-item" style="border-left-color:${p?.color}">
                    ${p?.icon} ${p?.label} @ ${this._fmtSec(fx.startTime)} / ${fx.duration.toFixed(1)}s
                    <button class="efx-remove" data-fxid="${fx.id}">✕</button>
                </div>`;
            }).join('') || '<small>まだFXがありません</small>';

            list.querySelectorAll('.efx-remove').forEach(btn => {
                btn.addEventListener('click', () => {
                    this._removeFxClip(track, btn.dataset.fxid);
                    _refreshList();
                });
            });
        };

        posSlider.addEventListener('input', () => posVal.textContent = parseFloat(posSlider.value).toFixed(1) + '秒');
        durSlider.addEventListener('input', () => durVal.textContent = parseFloat(durSlider.value).toFixed(1) + '秒');

        popup.querySelectorAll('.easy-fx-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const pos = parseFloat(posSlider.value);
                const dur = parseFloat(durSlider.value);
                this._addFxClip(track, btn.dataset.fx, pos, dur);
                _refreshList();
                const p = this._fxPresets.find(x => x.id === btn.dataset.fx);
                this._toast(`${p.icon} ${p.label} を追加しました`, 'success');
            });
        });

        popup.querySelector('.easy-fx-close').addEventListener('click', () => popup.remove());
        _refreshList();
    }

    /** 全トラックのFXレーンを更新（ズーム変更時など） */
    _refreshAllFxLanes() {
        this.tracks.forEach(t => {
            if (t.fxClips?.length) this._renderFxLane(t);
        });
    }

    _setZoom(newPps) {
        const oldPps = this.pixelsPerSecond;
        this.pixelsPerSecond = Math.max(10, Math.min(800, newPps));

        // 現在の再生位置を画面中央に維持するよう scrollLeft を補正
        const container = document.getElementById('tracks-container');
        const trackHeaderWidth = 180;
        const viewWidth = (container.offsetWidth - trackHeaderWidth) || 800;
        const curTime = this.audioEngine.getCurrentTime();
        const newContentPos = curTime * this.pixelsPerSecond;

        // 全クリップの left / width を更新
        this.tracks.forEach(track => {
            track.clips.forEach(clip => {
                const clipEl = document.querySelector(`[data-clip-id="${clip.id}"]`);
                if (!clipEl) return;
                clipEl.style.left  = (clip.startTime * this.pixelsPerSecond) + 'px';
                clipEl.style.width = (clip.duration  * this.pixelsPerSecond) + 'px';
            });
        });

        this._updateCanvasAreaWidths();
        this._updateRuler();
        this._refreshAllFxLanes();

        // 波形を新しいズームで再描画
        this.tracks.forEach(track => {
            track.clips.forEach(clip => {
                if (!clip.buffer) return;
                const clipEl = document.querySelector(`[data-clip-id="${clip.id}"]`);
                if (!clipEl) return;
                const canvas = clipEl.querySelector('.clip-waveform');
                if (canvas) {
                    // 少し待ってレイアウト確定後に描画
                    requestAnimationFrame(() => {
                        this.waveform.drawClipWaveform(canvas, clip.buffer, clip.offset || 0, clip.duration);
                    });
                }
            });
        });

        // 再生位置が画面内に収まるようスクロール調整
        container.scrollLeft = Math.max(0, newContentPos - viewWidth / 2);
        this.scrollOffset = container.scrollLeft;

        // プレイヘッド位置も更新
        const time = this.audioEngine.getCurrentTime();
        this._updatePlayhead(time);
    }

    _formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }

    _updateRuler() {
        const canvas = document.getElementById('ruler-canvas');
        let maxDuration = 60;
        this.tracks.forEach(t => t.clips.forEach(c => {
            const end = (c.startTime || 0) + c.duration;
            if (end > maxDuration) maxDuration = end;
        }));
        this.waveform.drawRuler(canvas, Math.max(maxDuration + 10, 60), this.pixelsPerSecond, this.scrollOffset);
    }

    _applySoloState() {
        const anySolo = this.tracks.some(t => t.solo);
        this.tracks.forEach(t => {
            if (anySolo) t.nodes.gainNode.gain.value = t.solo ? t.volume : 0;
            else t.nodes.gainNode.gain.value = t.muted ? 0 : t.volume;
        });
    }

    _updatePropertiesPanel(track, clip) {
        const content = document.getElementById('properties-content');
        let html = `<div style="font-size:12px"><p><strong>トラック:</strong> ${escapeHtml(track.name)}</p>`;
        if (clip) {
            html += `<hr style="border-color:var(--border);margin:8px 0">`;
            html += `<p><strong>クリップ:</strong> ${escapeHtml(clip.name)}</p>`;
            html += `<p><strong>長さ:</strong> ${escapeHtml(clip.duration.toFixed(2))}s</p>`;
        }
        html += `</div>`;
        content.innerHTML = html;
    }

    _updateEffectsPanel(track) {
        const list = document.getElementById('effect-list');
        const effects = this.effects.getTrackEffects(track.id);
        const addBtn = list.querySelector('.effect-add-btn');
        list.querySelectorAll('.effect-item').forEach(e => e.remove());
        effects.forEach((effect, i) => {
            const item = document.createElement('div');
            item.className = 'effect-item';
            item.innerHTML = `<span class="effect-item-name">${escapeHtml(effect.name)}</span><button class="effect-remove" data-index="${i}"><i class="fas fa-times"></i></button>`;
            item.querySelector('.effect-remove').addEventListener('click', () => {
                this.effects.removeEffectFromTrack(track.id, i);
                this._updateEffectsPanel(track);
            });
            list.insertBefore(item, addBtn);
        });
    }

    _updateMixerUI() {
        const container = document.getElementById('mixer-channels');
        container.innerHTML = '';
        this.tracks.forEach(track => {
            const ch = document.createElement('div');
            ch.className = 'mixer-channel';
            ch.dataset.trackId = track.id;
            const trackNameShort = track.name.length > 8 ? track.name.replace(/^[^\s]+\s*/,'').substring(0,8) + '…' : track.name;
            ch.innerHTML = `
                <h4 title="${escapeHtml(track.name)}">${escapeHtml(trackNameShort)}</h4>
                <div class="mixer-eq-section">
                    <div class="mixer-eq-row">
                        <span class="mixer-eq-band-label">Hi</span>
                        <input type="range" class="mixer-eq-knob" data-track-id="${track.id}" data-eq="high" min="-12" max="12" step="1" value="${track._eqHigh || 0}" title="高音 EQ: ${track._eqHigh || 0}dB">
                    </div>
                    <div class="mixer-eq-row">
                        <span class="mixer-eq-band-label">Mid</span>
                        <input type="range" class="mixer-eq-knob" data-track-id="${track.id}" data-eq="mid" min="-12" max="12" step="1" value="${track._eqMid || 0}" title="中音 EQ: ${track._eqMid || 0}dB">
                    </div>
                    <div class="mixer-eq-row">
                        <span class="mixer-eq-band-label">Lo</span>
                        <input type="range" class="mixer-eq-knob" data-track-id="${track.id}" data-eq="low" min="-12" max="12" step="1" value="${track._eqLow || 0}" title="低音 EQ: ${track._eqLow || 0}dB">
                    </div>
                    <div class="mixer-eq-row">
                        <span class="mixer-eq-band-label">Rev</span>
                        <input type="range" class="mixer-reverb-knob" data-track-id="${track.id}" min="0" max="100" step="5" value="${track._easyReverb || 0}" title="リバーブ: ${track._easyReverb || 0}%">
                    </div>
                </div>
                <div class="meter-container">
                    <canvas class="meter track-meter-l" width="16" height="52" data-track-id="${track.id}" data-ch="l"></canvas>
                    <canvas class="meter track-meter-r" width="16" height="52" data-track-id="${track.id}" data-ch="r"></canvas>
                </div>
                <input type="range" class="mixer-vol" data-track-id="${track.id}" min="0" max="1.5" step="0.01" value="${track.volume}" orient="vertical">
                <span class="volume-label">${Math.round(track.volume * 100)}%</span>
                <div class="mixer-buttons">
                    <button class="mixer-mute ${track.muted ? 'active-mute' : ''}" data-track-id="${track.id}">M</button>
                    <button class="mixer-solo ${track.solo ? 'active-solo' : ''}" data-track-id="${track.id}">S</button>
                </div>
            `;
            // EQノブ
            ch.querySelectorAll('.mixer-eq-knob').forEach(knob => {
                knob.addEventListener('input', (e) => {
                    const band = e.target.dataset.eq;
                    const val = parseInt(e.target.value);
                    const now = this.audioEngine.ctx.currentTime;
                    e.target.title = `${band === 'low' ? '低音' : band === 'mid' ? '中音' : '高音'} EQ: ${val > 0 ? '+' : ''}${val}dB`;
                    if (band === 'low' && track.nodes.eqLow) { track._eqLow = val; track.nodes.eqLow.gain.setValueAtTime(val, now); }
                    else if (band === 'mid' && track.nodes.eqMid) { track._eqMid = val; track.nodes.eqMid.gain.setValueAtTime(val, now); }
                    else if (band === 'high' && track.nodes.eqHigh) { track._eqHigh = val; track.nodes.eqHigh.gain.setValueAtTime(val, now); }
                });
            });
            // リバーブノブ
            ch.querySelector('.mixer-reverb-knob').addEventListener('input', (e) => {
                const wet = parseInt(e.target.value) / 100;
                track._easyReverb = parseInt(e.target.value);
                e.target.title = `リバーブ: ${e.target.value}%`;
                if (track.nodes.reverbWet) {
                    const now = this.audioEngine.ctx.currentTime;
                    track.nodes.reverbWet.gain.setValueAtTime(wet * 0.85, now);
                    track.nodes.reverbDry.gain.setValueAtTime(1.0 - wet * 0.5, now);
                }
            });
            ch.querySelector('.mixer-vol').addEventListener('input', (e) => {
                track.volume = parseFloat(e.target.value);
                if (!track.muted) track.nodes.gainNode.gain.setValueAtTime(track.volume, this.audioEngine.ctx.currentTime);
                ch.querySelector('.volume-label').textContent = Math.round(track.volume * 100) + '%';
            });
            ch.querySelector('.mixer-mute').addEventListener('click', () => {
                track.muted = !track.muted;
                track.nodes.gainNode.gain.value = track.muted ? 0 : track.volume;
                this._updateMixerUI();
            });
            ch.querySelector('.mixer-solo').addEventListener('click', () => {
                track.solo = !track.solo;
                this._applySoloState();
                this._updateMixerUI();
            });
            container.appendChild(ch);
        });
    }

    _updateAutomationTrackSelect() {
        const select = document.getElementById('automation-track');
        select.innerHTML = '';
        this.tracks.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            select.appendChild(opt);
        });
        if (this.tracks.length > 0) this.automation.setTrack(this.tracks[0].id);
    }

    _updateRemixUI() {
        // Update song library (depot)
        const pool = document.getElementById('plarail-song-pool');
        if (!pool) return;
        pool.innerHTML = '';

        if (this.remix.songs.length === 0) {
            pool.innerHTML = '<div class="plarail-empty-hint">← 曲を追加してプラレールみたいにつなごう！</div>';
        } else {
            this.remix.songs.forEach(song => {
                const car = document.createElement('div');
                car.className = 'plarail-depot-car';
                car.draggable = true;
                car.dataset.songId = song.id;
                const bgAlpha = 'rgba(' + this._hexToRgb(song.color) + ',0.15)';
                car.innerHTML = `
                    <div class="plarail-depot-car-body" style="border-color:${escapeHtml(song.color)};background:${bgAlpha}">
                        <span style="font-size:11px;font-weight:700;color:${escapeHtml(song.color)}">${escapeHtml(song.name.length > 8 ? song.name.slice(0,7)+'…' : song.name)}</span>
                        <span style="font-size:9px;color:var(--text-muted)">${escapeHtml(this._fmtDur(song.duration))}</span>
                        <button class="car-remove" title="削除"><i class="fas fa-times"></i></button>
                    </div>
                    <span class="plarail-depot-car-name">${escapeHtml(song.name)}</span>
                `;
                car.querySelector('.car-remove').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.remix.removeSong(song.id);
                    this._updateRemixUI();
                });
                car.addEventListener('click', () => {
                    this.remix.addToSequence(song.id);
                    this._updateRemixRailUI();
                });
                car.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'depot', songId: song.id }));
                    e.dataTransfer.effectAllowed = 'copy';
                });
                pool.appendChild(car);
            });
        }
        this._updateRemixRailUI();
    }

    _updateRemixRailUI() {
        const carsEl = document.getElementById('plarail-cars');
        if (!carsEl) return;
        carsEl.innerHTML = '';

        if (this.remix.sequence.length === 0) {
            carsEl.innerHTML = '<div class="plarail-rail-empty">← ライブラリから曲をドラッグ、またはクリックして接続</div>';
        } else {
            this.remix.sequence.forEach((seg, i) => {
                const song = this.remix.getSong(seg.songId);
                if (!song) return;

                if (i > 0) {
                    const connector = document.createElement('div');
                    connector.className = 'plarail-connector';
                    connector.title = `継ぎ目 ${i}: クロスフェード ${this.remix.crossfadeDuration}秒`;
                    carsEl.appendChild(connector);
                }

                const car = document.createElement('div');
                car.className = 'plarail-rail-car';
                car.draggable = true;
                car.dataset.seqIndex = i;
                const bgAlpha = 'rgba(' + this._hexToRgb(song.color) + ',0.2)';
                car.innerHTML = `
                    <div class="plarail-rail-car-body" style="border-color:${escapeHtml(song.color)};background:${bgAlpha}">
                        <span class="car-seq-num">${i + 1}</span>
                        <span class="plarail-rail-car-name" style="color:${escapeHtml(song.color)}">${escapeHtml(song.name)}</span>
                        <span class="plarail-rail-car-dur">${escapeHtml(this._fmtDur(song.duration))}</span>
                        <button class="car-remove-btn" title="レールから外す"><i class="fas fa-times"></i></button>
                    </div>
                `;
                car.querySelector('.car-remove-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.remix.removeFromSequence(i);
                    this._updateRemixRailUI();
                });
                car.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'rail', seqIndex: i }));
                    e.dataTransfer.effectAllowed = 'move';
                    car.style.opacity = '0.5';
                });
                car.addEventListener('dragend', () => { car.style.opacity = ''; });
                car.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    car.classList.add('drag-over-left');
                });
                car.addEventListener('dragleave', () => { car.classList.remove('drag-over-left'); car.classList.remove('drag-over-right'); });
                car.addEventListener('drop', (e) => {
                    e.preventDefault();
                    car.classList.remove('drag-over-left'); car.classList.remove('drag-over-right');
                    try {
                        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                        if (data.type === 'rail') {
                            const from = data.seqIndex;
                            const to = i;
                            if (from !== to) { this.remix.moveInSequence(from, to); this._updateRemixRailUI(); }
                        } else if (data.type === 'depot') {
                            this.remix.sequence.splice(i, 0, { songId: data.songId, startTrim: 0, endTrim: this.remix.getSong(data.songId)?.duration || 0 });
                            this._updateRemixRailUI();
                        }
                    } catch(err) {}
                });
                carsEl.appendChild(car);
            });
        }

        // Drop zone at end
        const dropEnd = document.getElementById('plarail-drop-end');
        if (dropEnd) {
            dropEnd.ondragover = (e) => { e.preventDefault(); dropEnd.classList.add('drag-active'); };
            dropEnd.ondragleave = () => dropEnd.classList.remove('drag-active');
            dropEnd.ondrop = (e) => {
                e.preventDefault();
                dropEnd.classList.remove('drag-active');
                try {
                    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                    if (data.type === 'depot') {
                        const song = this.remix.getSong(data.songId);
                        if (song) { this.remix.addToSequence(data.songId); this._updateRemixRailUI(); }
                    } else if (data.type === 'rail') {
                        const last = this.remix.sequence.length - 1;
                        if (data.seqIndex !== last) { this.remix.moveInSequence(data.seqIndex, last); this._updateRemixRailUI(); }
                    }
                } catch(err) {}
            };
            dropEnd.onclick = () => {
                if (this.remix.songs.length > 0) {
                    const song = this.remix.songs[0];
                    this.remix.addToSequence(song.id);
                    this._updateRemixRailUI();
                }
            };
        }
    }

    _updateRemixSequenceUI() { this._updateRemixRailUI(); }

    _fmtDur(sec) {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m > 0 ? `${m}:${String(s).padStart(2,'0')}` : `${s}s`;
    }

    _hexToRgb(hex) {
        // 3桁 (#RGB) を6桁に展開してからパース
        let h = hex.replace(/^#/, '');
        if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
        const r = parseInt(h.slice(0,2),16);
        const g = parseInt(h.slice(2,4),16);
        const b = parseInt(h.slice(4,6),16);
        return `${r},${g},${b}`;
    }

    _startMeters() {
        const update = () => {
            if (this.audioEngine.isPlaying) {
                const lLevel = this.audioEngine.getMeterData(this.audioEngine.masterAnalyserL);
                const rLevel = this.audioEngine.getMeterData(this.audioEngine.masterAnalyserR);
                this.waveform.drawMeter(document.getElementById('master-meter-l'), lLevel);
                this.waveform.drawMeter(document.getElementById('master-meter-r'), rLevel);
                this.tracks.forEach(track => {
                    const level = this.audioEngine.getMeterData(track.nodes.analyser);
                    const lCanvas = document.querySelector(`.track-meter-l[data-track-id="${track.id}"]`);
                    const rCanvas = document.querySelector(`.track-meter-r[data-track-id="${track.id}"]`);
                    if (lCanvas) this.waveform.drawMeter(lCanvas, level);
                    if (rCanvas) this.waveform.drawMeter(rCanvas, level * 0.95);
                });
            }
            // スペクトラムは常時描画（停止中は空＝グリッドのみ）
            this._drawSpectrum();
            this._drawPhaseCorrelation();
            this._meterRAF = requestAnimationFrame(update);
        };
        this._meterRAF = requestAnimationFrame(update);
    }

    // リアルタイム周波数スペクトラム表示（対数軸＋ピークホールド）
    _drawSpectrum() {
        const canvas = document.getElementById('spectrum-canvas');
        const analyser = this.audioEngine.masterAnalyserL;
        if (!canvas || !analyser) return;
        // 非表示（別タブ表示中など）は描画スキップ＝無駄な処理を回避
        if (canvas.offsetParent === null) return;

        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        const sr = this.audioEngine.ctx.sampleRate;
        const bins = analyser.frequencyBinCount;
        const freqData = new Uint8Array(bins);
        analyser.getByteFrequencyData(freqData);

        // 背景
        ctx.fillStyle = '#0d1b2a';
        ctx.fillRect(0, 0, W, H);

        // 対数バー: 20Hz〜20kHz を NB本に分割
        const NB = 56;
        const fMin = 20, fMax = 20000;
        const binHz = sr / (analyser.fftSize);

        if (!this._spectrumPeaks || this._spectrumPeaks.length !== NB) {
            this._spectrumPeaks = new Float32Array(NB);
        }
        const peaks = this._spectrumPeaks;

        // 周波数グリッド線（100Hz / 1kHz / 10kHz）
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.fillStyle = 'rgba(160,160,176,0.7)';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'center';
        [100, 1000, 10000].forEach(f => {
            const x = W * (Math.log(f / fMin) / Math.log(fMax / fMin));
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 10); ctx.stroke();
            const label = f >= 1000 ? (f / 1000) + 'k' : f + '';
            ctx.fillText(label, x, H - 1);
        });

        const barW = W / NB;
        for (let i = 0; i < NB; i++) {
            // このバーが担当する周波数範囲（対数）
            const f0 = fMin * Math.pow(fMax / fMin, i / NB);
            const f1 = fMin * Math.pow(fMax / fMin, (i + 1) / NB);
            const b0 = Math.max(1, Math.floor(f0 / binHz));
            const b1 = Math.min(bins - 1, Math.ceil(f1 / binHz));
            let max = 0;
            for (let b = b0; b <= b1; b++) if (freqData[b] > max) max = freqData[b];
            const v = max / 255;

            // ピークホールド（ゆっくり落ちる）
            if (v > peaks[i]) peaks[i] = v;
            else peaks[i] = Math.max(0, peaks[i] - 0.015);

            const barH = v * (H - 12);
            const x = i * barW;
            // 帯域で色を変える（低=青 / 中=緑 / 高=赤寄り）
            const hue = 200 - (i / NB) * 200;
            ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;
            ctx.fillRect(x, H - 10 - barH, barW - 1, barH);

            // ピークマーカー
            const py = H - 10 - peaks[i] * (H - 12);
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.fillRect(x, py, barW - 1, 2);
        }
    }

    // モノ互換／位相相関メーター（L/Rの相関係数: +1=モノ安全, -1=逆相危険）
    _drawPhaseCorrelation() {
        const canvas = document.getElementById('phase-canvas');
        const aL = this.audioEngine.masterAnalyserL;
        const aR = this.audioEngine.masterAnalyserR;
        if (!canvas || !aL || !aR) return;
        if (canvas.offsetParent === null) return;

        const N = aL.fftSize;
        const L = new Float32Array(N);
        const R = new Float32Array(N);
        aL.getFloatTimeDomainData(L);
        aR.getFloatTimeDomainData(R);

        // ピアソン相関係数
        let sumL = 0, sumR = 0;
        for (let i = 0; i < N; i++) { sumL += L[i]; sumR += R[i]; }
        const mL = sumL / N, mR = sumR / N;
        let num = 0, dL = 0, dR = 0;
        for (let i = 0; i < N; i++) {
            const a = L[i] - mL, b = R[i] - mR;
            num += a * b; dL += a * a; dR += b * b;
        }
        let corr = (dL > 1e-9 && dR > 1e-9) ? num / Math.sqrt(dL * dR) : 1;
        // 無音時は+1（モノ安全）扱い
        if (dL < 1e-7 && dR < 1e-7) corr = 1;

        // スムージング
        this._phaseCorr = this._phaseCorr == null ? corr : this._phaseCorr * 0.8 + corr * 0.2;
        const c = this._phaseCorr;

        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        // 背景トラック
        ctx.fillStyle = '#0d1b2a';
        ctx.fillRect(0, 0, W, H);
        // 中央(0)目盛り
        const mid = W / 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.beginPath(); ctx.moveTo(mid, 0); ctx.lineTo(mid, H); ctx.stroke();
        // インジケータ位置: -1→左端, +1→右端
        const x = ((c + 1) / 2) * W;
        // 危険(<0)=赤, 注意(0〜0.3)=黄, 安全(>0.3)=緑
        let col = '#22c55e';
        if (c < 0) col = '#e94560';
        else if (c < 0.3) col = '#eab308';
        ctx.fillStyle = col;
        ctx.fillRect(Math.min(x, mid), 0, Math.abs(x - mid), H);

        const val = document.getElementById('phase-value');
        if (val) {
            val.textContent = (c >= 0 ? '+' : '') + c.toFixed(2);
            val.style.color = col;
        }
    }

    // ============================================
    // A/Bテイク比較（本体トランスポートとは独立した再生）
    // ============================================
    _setupABCompare() {
        // 状態（独立管理：this.tracks や audioEngine.play とは無関係）
        this._ab = {
            bufferA: null, bufferB: null,
            gainBtoA: 1.0,          // Bをaに揃えるゲイン
            source: null, gainNode: null,
            current: 'A', playing: false,
            startCtxTime: 0, offset: 0
        };

        const loadFile = async (slot, file) => {
            if (!file) return;
            const nameEl = document.getElementById('ab-name-' + slot.toLowerCase());
            try {
                const arr = await file.arrayBuffer();
                const buf = await this.audioEngine.decodeAudio(arr);
                if (slot === 'A') this._ab.bufferA = buf; else this._ab.bufferB = buf;
                if (nameEl) nameEl.textContent = '✅ ' + file.name;
                // 両方そろったらラウドネスマッチ
                if (this._ab.bufferA && this._ab.bufferB) {
                    const m = await this.proTools.loudnessMatch(this._ab.bufferA, this._ab.bufferB);
                    this._ab.gainBtoA = isFinite(m.gainBtoA) ? m.gainBtoA : 1.0;
                    const st = document.getElementById('ab-status');
                    if (st) st.textContent = `音量補正済み（A:${m.lufsA.toFixed(1)} / B:${m.lufsB.toFixed(1)} LUFS）→ 再生して切替`;
                    this._drawABOverlay();
                }
            } catch (e) {
                this._toast('A/B読込失敗: ' + e.message, 'error');
            }
        };

        document.getElementById('btn-ab-load-a')?.addEventListener('click', () => document.getElementById('ab-file-a')?.click());
        document.getElementById('btn-ab-load-b')?.addEventListener('click', () => document.getElementById('ab-file-b')?.click());
        document.getElementById('ab-file-a')?.addEventListener('change', e => loadFile('A', e.target.files?.[0]));
        document.getElementById('ab-file-b')?.addEventListener('change', e => loadFile('B', e.target.files?.[0]));

        const startSource = (offset) => {
            const ab = this._ab;
            const buf = ab.current === 'A' ? ab.bufferA : ab.bufferB;
            if (!buf) return;
            this.audioEngine.resume();
            const ctx = this.audioEngine.ctx;
            ab.source = ctx.createBufferSource();
            ab.source.buffer = buf;
            ab.source.loop = true;
            ab.gainNode = ctx.createGain();
            ab.gainNode.gain.value = ab.current === 'B' ? ab.gainBtoA : 1.0;
            ab.source.connect(ab.gainNode);
            ab.gainNode.connect(this.audioEngine.masterGain);
            ab.startCtxTime = ctx.currentTime;
            ab.offset = offset % buf.duration;
            ab.source.start(0, ab.offset);
            ab.playing = true;
        };
        const stopSource = () => {
            const ab = this._ab;
            if (ab.source) { try { ab.source.stop(); } catch (e) {} ab.source.disconnect(); ab.source = null; }
            if (ab.gainNode) { ab.gainNode.disconnect(); ab.gainNode = null; }
        };
        const currentOffset = () => {
            const ab = this._ab;
            if (!ab.playing) return 0;
            const buf = ab.current === 'A' ? ab.bufferA : ab.bufferB;
            const elapsed = this.audioEngine.ctx.currentTime - ab.startCtxTime + ab.offset;
            return buf ? elapsed % buf.duration : 0;
        };

        document.getElementById('btn-ab-play')?.addEventListener('click', () => {
            if (!this._ab.bufferA && !this._ab.bufferB) { this._toast('先にA/Bを読み込んでください', 'error'); return; }
            // 本体再生が動いていたら止めて競合回避
            if (this.audioEngine.isPlaying) { document.getElementById('btn-play')?.click(); }
            stopSource();
            startSource(0);
            this._toast(`比較再生開始（${this._ab.current}）`, 'info');
        });
        document.getElementById('btn-ab-toggle')?.addEventListener('click', () => {
            const ab = this._ab;
            if (!ab.bufferA || !ab.bufferB) { this._toast('A/B両方を読み込むと切替できます', 'warning'); return; }
            const pos = currentOffset();
            ab.current = ab.current === 'A' ? 'B' : 'A';
            document.getElementById('ab-current').textContent = ab.current;
            if (ab.playing) { stopSource(); startSource(pos); } // 同じ位置でシームレス切替
        });
        document.getElementById('btn-ab-stop')?.addEventListener('click', () => {
            stopSource();
            this._ab.playing = false;
        });
    }

    /** A/B波形オーバーレイ描画（音量補正後・差分ハイライト付き／描画のみ） */
    _drawABOverlay() {
        const canvas = document.getElementById('ab-overlay-canvas');
        const ab = this._ab;
        if (!canvas || !ab || !ab.bufferA || !ab.bufferB) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height, mid = H / 2;
        ctx.clearRect(0, 0, W, H);

        // ピークエンベロープ抽出（音量補正：BにはgainBtoAを掛けて公平比較）
        const envelope = (buf, gain) => {
            const ch = buf.getChannelData(0);
            const ch2 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
            const step = Math.max(1, Math.floor(buf.length / W));
            const peaks = new Float32Array(W);
            for (let x = 0; x < W; x++) {
                let p = 0;
                const start = x * step, end = Math.min(start + step, buf.length);
                for (let i = start; i < end; i++) {
                    let v = Math.abs(ch[i]);
                    if (ch2) v = Math.max(v, Math.abs(ch2[i]));
                    if (v > p) p = v;
                }
                peaks[x] = Math.min(1, p * gain);
            }
            return peaks;
        };
        const pa = envelope(ab.bufferA, 1.0);
        const pb = envelope(ab.bufferB, ab.gainBtoA || 1.0);

        // 差分ハイライト（背景）
        for (let x = 0; x < W; x++) {
            const diff = Math.abs(pa[x] - pb[x]);
            if (diff > 0.04) {
                ctx.fillStyle = `rgba(233,69,96,${Math.min(0.5, diff * 1.2)})`;
                ctx.fillRect(x, 0, 1, H);
            }
        }
        // 中央線
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

        const drawWave = (peaks, color) => {
            ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
            for (let x = 0; x < W; x++) {
                const h = peaks[x] * mid;
                ctx.moveTo(x, mid - h); ctx.lineTo(x, mid + h);
            }
            ctx.stroke();
        };
        // A=シアン半透明、B=黄半透明（重なりが見える）
        ctx.globalAlpha = 0.55; drawWave(pa, '#22d3ee');
        ctx.globalAlpha = 0.55; drawWave(pb, '#facc15');
        ctx.globalAlpha = 1.0;
    }


    // ============================================
    // PRO TOOLS
    // ============================================

    _updateProTargetTrackList() {
        const sel = document.getElementById('pro-target-track');
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = '';
        this.tracks.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name + (t.clips.length > 0 ? ` (${t.clips.length}クリップ)` : '');
            sel.appendChild(opt);
        });
        if (prev) sel.value = prev;
    }

    _getProTargetBuffer() {
        const sel = document.getElementById('pro-target-track');
        if (!sel || !sel.value) return null;
        const track = this.tracks.find(t => t.id === sel.value);
        if (!track || track.clips.length === 0) return null;
        return track.clips[0]; // first clip
    }

    _applyBufferToClip(track, clip, newBuffer) {
        // 編集前の状態をUndoスタックへ記録（全バッファ編集の共通入口）
        if (!track._pristineBuffer) track._pristineBuffer = clip.buffer; // 初回編集時の元音源を保持
        this._pushUndo();

        // 再生中の場合は一時停止してから適用（旧バッファのまま再生が続くのを防ぐ）
        const wasPlaying = this.audioEngine.isPlaying;
        if (wasPlaying) {
            this.audioEngine.stop();
            document.getElementById('btn-play').innerHTML = '<i class="fas fa-play"></i>';
            document.getElementById('btn-play').classList.remove('active');
        }
        clip.buffer = newBuffer;
        clip.duration = newBuffer.duration;
        clip._saved = false; // 編集後のバッファを再保存させる
        this._renderClip(track, clip);
        this._updateCanvasAreaWidths?.();
        this._saveProject(); // 即時保存
        if (this.easyMode) this._renderEasyCards?.();
        this._updateUndoButtons();
        if (wasPlaying) this._toast('適用しました。▶ 再生で確認できます', 'info');
    }

    // ============================================
    // UNDO / REDO（スナップショット方式）
    // バッファ編集・カット・削除など破壊的操作の直前に
    // _pushUndo() で現在状態を保存。バッファは不変なので参照保持で軽量。
    // ============================================
    _captureState() {
        const bands = ['low', 'lowmid', 'mid', 'highmid', 'high'];
        return {
            bpm: this.audioEngine.bpm,
            originalBpm: this.audioEngine.originalBpm,
            bpmRatio: this.audioEngine.bpmRatio,
            masterEQ: bands.map(b => this.audioEngine.masterEQ[b]?.gain.value ?? 0),
            tracks: this.tracks.map(t => ({
                id: t.id,
                volume: t.volume, pan: t.pan, muted: t.muted, solo: t.solo,
                eqLow: t.nodes?.eqLow?.gain.value ?? 0,
                eqMid: t.nodes?.eqMid?.gain.value ?? 0,
                eqHigh: t.nodes?.eqHigh?.gain.value ?? 0,
                reverbWet: t.nodes?.reverbWet?.gain.value ?? 0,
                fxClips: (t.fxClips || []).map(f => ({ ...f })),
                clips: t.clips.map(c => ({
                    id: c.id, name: c.name, buffer: c.buffer,
                    startTime: c.startTime, duration: c.duration,
                    offset: c.offset || 0, _gain: c._gain ?? 1.0
                }))
            }))
        };
    }

    _applyState(s) {
        if (!s) return;
        this.audioEngine.bpm = s.bpm;
        this.audioEngine.originalBpm = s.originalBpm;
        this.audioEngine.bpmRatio = s.bpmRatio;
        const bpmInput = document.getElementById('bpm-input');
        if (bpmInput) bpmInput.value = s.bpm;
        const bands = ['low', 'lowmid', 'mid', 'highmid', 'high'];
        s.masterEQ.forEach((v, i) => this.audioEngine.setMasterEQ(bands[i], v));

        // 再生中なら一旦停止（古いソースが残らないように）
        if (this.audioEngine.isPlaying) {
            this.audioEngine.stop();
            const pb = document.getElementById('btn-play');
            if (pb) { pb.innerHTML = '<i class="fas fa-play"></i>'; pb.classList.remove('active'); }
        }

        const now = this.audioEngine.ctx.currentTime;
        s.tracks.forEach(ts => {
            const track = this.tracks.find(t => t.id === ts.id);
            if (!track) return;
            track.volume = ts.volume; track.pan = ts.pan; track.muted = ts.muted; track.solo = ts.solo;
            if (track.nodes) {
                track.nodes.gainNode.gain.setValueAtTime(ts.muted ? 0 : ts.volume, now);
                track.nodes.panNode.pan.setValueAtTime(ts.pan, now);
                track.nodes.eqLow?.gain.setValueAtTime(ts.eqLow, now);
                track.nodes.eqMid?.gain.setValueAtTime(ts.eqMid, now);
                track.nodes.eqHigh?.gain.setValueAtTime(ts.eqHigh, now);
                if (track.nodes.reverbWet) {
                    track.nodes.reverbWet.gain.setValueAtTime(ts.reverbWet, now);
                    track.nodes.reverbDry?.gain.setValueAtTime(1, now);
                }
            }
            track.fxClips = ts.fxClips.map(f => ({ ...f }));
            track.clips = ts.clips.map(c => ({
                id: c.id, name: c.name, buffer: c.buffer,
                startTime: c.startTime, duration: c.duration,
                offset: c.offset, _gain: c._gain, _saved: false
            }));
            this._rerenderTrackClips(track);
            this._renderFxLane?.(track);
            this._updateTrackHeader?.(track);
        });
        this._updateCanvasAreaWidths?.();
        this._updateMixerUI?.();
        if (this.easyMode) this._renderEasyCards?.();
        this._saveProject?.();
    }

    _rerenderTrackClips(track) {
        const trackDiv = document.querySelector(`[data-track-id="${track.id}"].track`);
        if (!trackDiv) return;
        const area = trackDiv.querySelector('.track-canvas-area');
        if (area) area.querySelectorAll('.clip').forEach(el => el.remove());
        track.clips.forEach(c => this._renderClip(track, c));
    }

    _pushUndo(state) {
        this.undoStack.push(state || this._captureState());
        if (this.undoStack.length > 50) this.undoStack.shift();
        this.redoStack = [];
        this._updateUndoButtons();
    }

    _undo() {
        if (!this.undoStack.length) { this._toast('元に戻す操作がありません', 'info'); return; }
        this.redoStack.push(this._captureState());
        this._applyState(this.undoStack.pop());
        this._updateUndoButtons();
        this._toast('元に戻しました', 'success');
    }

    _redo() {
        if (!this.redoStack.length) { this._toast('やり直す操作がありません', 'info'); return; }
        this.undoStack.push(this._captureState());
        this._applyState(this.redoStack.pop());
        this._updateUndoButtons();
        this._toast('やり直しました', 'success');
    }

    _updateUndoButtons() {
        const u = document.getElementById('btn-undo');
        const r = document.getElementById('btn-redo');
        if (u) u.disabled = this.undoStack.length === 0;
        if (r) r.disabled = this.redoStack.length === 0;
    }

    _setupProToolsListeners() {
        // Populate target track on panel open
        document.querySelector('[data-panel="protools"]')?.addEventListener('click', () => {
            this._updateProTargetTrackList();
        });

        // Helper: chip group single-select
        const setupChips = (containerId) => {
            const container = document.getElementById(containerId);
            if (!container) return;
            container.addEventListener('click', (e) => {
                const chip = e.target.closest('.preset-chip');
                if (!chip) return;
                container.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
            });
        };
        setupChips('autotune-style-chips');
        setupChips('vcomp-preset-chips');
        setupChips('buildup-style-chips');
        setupChips('segment-count-chips');

        // Range display helpers
        const rangeDisplay = (id, displayId, fmt) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', () => {
                document.getElementById(displayId).textContent = fmt(parseFloat(el.value));
            });
        };
        const silenceLabels = ['弱', '標準', '強め', '最強', '超高感度'];
        document.getElementById('silence-threshold')?.addEventListener('input', (e) => {
            document.getElementById('silence-threshold-val').textContent = silenceLabels[parseInt(e.target.value) - 1];
        });
        rangeDisplay('fade-duration',    'fade-duration-val',     v => v.toFixed(1) + '秒');
        rangeDisplay('autotune-intensity','autotune-intensity-val',v => Math.round(v * 100) + '%');
        rangeDisplay('sweep-duration',   'sweep-duration-val',    v => v.toFixed(1) + '秒');
        rangeDisplay('buildup-duration', 'buildup-duration-val',  v => v + '秒');

        // Helper to get clip for processing
        const getClip = () => {
            this._updateProTargetTrackList();
            const sel = document.getElementById('pro-target-track');
            if (!sel?.value) { this._toast('適用先トラックを選んでください', 'error'); return null; }
            const track = this.tracks.find(t => t.id === sel.value);
            if (!track || track.clips.length === 0) { this._toast('選択したトラックにクリップがありません', 'error'); return null; }
            return { track, clip: track.clips[0] };
        };

        // 1. 無音カット
        document.getElementById('btn-trim-silence')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            const level = parseInt(document.getElementById('silence-threshold').value);
            const thresholds = [0.005, 0.015, 0.03, 0.05, 0.08];
            this._showLoading('無音を検出中...');
            try {
                const newBuf = await this.proTools.trimSilence(tc.clip.buffer, thresholds[level - 1]);
                const trimmed = (tc.clip.buffer.duration - newBuf.duration).toFixed(2);
                this._applyBufferToClip(tc.track, tc.clip, newBuf);
                this._hideLoading();
                this._toast(`無音カット完了 (${trimmed}秒除去)`, 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });

        // 2. アウトロフェード
        document.getElementById('btn-outro-fade')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            const dur = parseFloat(document.getElementById('fade-duration').value);
            const type = document.getElementById('fade-type').value;
            this._showLoading('フェードアウト適用中...');
            try {
                const newBuf = await this.proTools.applyOutroFade(tc.clip.buffer, dur, type);
                this._applyBufferToClip(tc.track, tc.clip, newBuf);
                this._hideLoading();
                this._toast(`アウトロフェード適用 (${dur}秒)`, 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });

        // 1.5 イントロフェードイン
        document.getElementById('fadein-duration')?.addEventListener('input', (e) => {
            const el = document.getElementById('fadein-duration-val');
            if (el) el.textContent = parseFloat(e.target.value).toFixed(1) + '秒';
        });
        document.getElementById('btn-intro-fade')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            const dur = parseFloat(document.getElementById('fadein-duration').value);
            const type = document.getElementById('fadein-type').value;
            this._showLoading('フェードイン適用中...');
            try {
                const newBuf = await this.proTools.applyIntroFade(tc.clip.buffer, dur, type);
                this._applyBufferToClip(tc.track, tc.clip, newBuf);
                this._hideLoading();
                this._toast(`イントロフェードイン適用 (${dur}秒)`, 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });

        // 2.5 Suno AIクリーンアップEQ（マスターEQプリセット・トグル）
        document.getElementById('btn-suno-eq')?.addEventListener('click', () => {
            const enabled = this.audioEngine.setSunoEQPreset(!this.audioEngine.sunoEnabled);
            const btn = document.getElementById('btn-suno-eq');
            const status = document.getElementById('suno-eq-status');
            if (btn) btn.classList.toggle('active', enabled);
            if (status) status.textContent = enabled ? '現在: オン ✅' : '現在: オフ';
            // マスタリングパネルのEQスライダー表示も同期
            this._syncMasterEQSliders();
            this._toast(enabled
                ? 'Suno AIクリーンアップEQ：オン（マスターEQに適用）'
                : 'Suno AIクリーンアップEQ：オフ（元の設定に復元）', enabled ? 'success' : 'info');
        });

        // 2.6 リファレンスEQマッチング
        this._refEqBuffer = null;
        document.getElementById('btn-ref-eq-pick')?.addEventListener('click', () => {
            document.getElementById('ref-eq-file')?.click();
        });
        document.getElementById('ref-eq-file')?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const status = document.getElementById('ref-eq-status');
            this._showLoading('参照曲を読み込み中...');
            try {
                const arrayBuffer = await file.arrayBuffer();
                this._refEqBuffer = await this.audioEngine.decodeAudio(arrayBuffer);
                if (status) status.textContent = '✅ ' + file.name;
                this._hideLoading();
                this._toast('参照曲を読み込みました。「解析して適用」を押してください', 'info');
            } catch (err) {
                this._hideLoading();
                this._refEqBuffer = null;
                if (status) status.textContent = '読込失敗';
                this._toast('参照曲の読込に失敗: ' + err.message, 'error');
            }
        });
        document.getElementById('btn-ref-eq-apply')?.addEventListener('click', async () => {
            if (!this._refEqBuffer) { this._toast('先に参照曲を選んでください', 'error'); return; }
            const tc = getClip(); if (!tc) return;
            this._showLoading('スペクトルを解析中...');
            try {
                // 非同期描画のため少し待つ
                await new Promise(r => setTimeout(r, 30));
                // Suno EQがON中なら状態をクリアして競合（OFF時の値復元上書き）を防ぐ
                if (this.audioEngine.sunoEnabled) {
                    this.audioEngine._presunoEQ = null;
                    this.audioEngine.sunoEnabled = false;
                    document.getElementById('btn-suno-eq')?.classList.remove('active');
                    const ss = document.getElementById('suno-eq-status');
                    if (ss) ss.textContent = '現在: オフ';
                }
                const eq = this.proTools.computeMatchingEQ(this._refEqBuffer, tc.clip.buffer);
                Object.entries(eq).forEach(([band, val]) => {
                    this.audioEngine.setMasterEQ(band, val);
                });
                this._syncMasterEQSliders();
                this._hideLoading();
                const summary = `Low ${eq.low>=0?'+':''}${eq.low} / LMid ${eq.lowmid>=0?'+':''}${eq.lowmid} / Mid ${eq.mid>=0?'+':''}${eq.mid} / HMid ${eq.highmid>=0?'+':''}${eq.highmid} / High ${eq.high>=0?'+':''}${eq.high} dB`;
                this._toast('リファレンスEQ適用完了 → ' + summary, 'success');
            } catch (err) {
                this._hideLoading();
                this._toast('解析エラー: ' + err.message, 'error');
            }
        });

        // 2.8 A/Bテイク比較
        this._setupABCompare();

        // 2.7 ラウドネス正規化（LUFS）
        document.getElementById('btn-lufs-normalize')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            const target = parseFloat(document.getElementById('lufs-target').value);
            this._showLoading('ラウドネスを測定中...');
            try {
                await new Promise(r => setTimeout(r, 30));
                const res = await this.proTools.normalizeLoudness(tc.clip.buffer, target);
                if (res.measured <= -70) {
                    this._hideLoading();
                    this._toast('無音に近いため正規化をスキップしました', 'warning');
                    return;
                }
                this._applyBufferToClip(tc.track, tc.clip, res.buffer);
                const status = document.getElementById('lufs-status');
                if (status) status.textContent = `${res.measured.toFixed(1)} → ${target} LUFS`;
                this._hideLoading();
                this._toast(`ラウドネス正規化完了（${res.measured.toFixed(1)} LUFS → ${target} LUFS / ゲイン ${res.gainDb>=0?'+':''}${res.gainDb.toFixed(1)}dB）`, 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });

        // 2.9 True Peak リミッター（dBTP）
        document.getElementById('btn-tp-measure')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            this._showLoading('True Peakを測定中...');
            try {
                const { dbtp } = await this.proTools.measureTruePeak(tc.clip.buffer);
                const status = document.getElementById('tp-status');
                const txt = dbtp === -Infinity ? '無音' : `${dbtp.toFixed(2)} dBTP`;
                if (status) {
                    status.textContent = txt;
                    status.style.color = dbtp > 0 ? '#e94560' : dbtp > -1 ? '#f0a020' : '#4ade80';
                }
                this._hideLoading();
                this._toast(`True Peak: ${txt}${dbtp > 0 ? '（0dBTP超え：歪みの危険）' : ''}`, dbtp > 0 ? 'warning' : 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });
        document.getElementById('btn-tp-limit')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            const ceiling = parseFloat(document.getElementById('tp-ceiling').value);
            this._showLoading('True Peakを制限中...');
            try {
                const res = await this.proTools.limitTruePeak(tc.clip.buffer, ceiling);
                const status = document.getElementById('tp-status');
                if (!res.changed) {
                    if (status) { status.textContent = `${res.peakDbtp.toFixed(2)} dBTP（変更なし）`; status.style.color = '#4ade80'; }
                    this._hideLoading();
                    this._toast(`すでに上限以下です（${res.peakDbtp.toFixed(2)} dBTP ≤ ${ceiling} dBTP）`, 'success');
                    return;
                }
                this._applyBufferToClip(tc.track, tc.clip, res.buffer);
                if (status) { status.textContent = `${res.peakDbtp.toFixed(2)} → ${ceiling} dBTP`; status.style.color = '#4ade80'; }
                this._hideLoading();
                this._toast(`True Peak制限完了（${res.peakDbtp.toFixed(2)} dBTP → ${ceiling} dBTP / ${res.gainDb.toFixed(1)}dB）`, 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });

        // 3. オートチューン / ケロケロ
        document.getElementById('btn-autotune')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            const style = document.querySelector('#autotune-style-chips .preset-chip.active')?.dataset.val || 'kero';
            const intensity = parseFloat(document.getElementById('autotune-intensity').value);
            this._showLoading('ボーカル加工中...');
            try {
                const newBuf = await this.proTools.applyAutotune(tc.clip.buffer, { style, intensity });
                this._applyBufferToClip(tc.track, tc.clip, newBuf);
                this._hideLoading();
                this._toast(`ボーカル加工完了 (${style === 'kero' ? 'ケロケロ' : 'スムース'})`, 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });

        // 4. J-POPコンプ
        document.getElementById('btn-vocal-comp')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            const preset = document.querySelector('#vcomp-preset-chips .preset-chip.active')?.dataset.val || 'medium';
            this._showLoading('コンプレッサー適用中...');
            try {
                const newBuf = await this.proTools.applyVocalComp(tc.clip.buffer, preset);
                this._applyBufferToClip(tc.track, tc.clip, newBuf);
                this._hideLoading();
                this._toast(`J-POPコンプ適用 (${preset})`, 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });

        // 5. スウィープ挿入
        document.getElementById('btn-insert-sweep')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            const dur = parseFloat(document.getElementById('sweep-duration').value);
            const pos = parseFloat(document.getElementById('sweep-position').value) || tc.clip.buffer.duration - dur;
            this._showLoading('スウィープ生成中...');
            try {
                const fxBuf = await this.proTools.generateReverseCymbal(dur);
                const sweepTrack = this.addTrack('スウィープFX');
                const sweepClip = {
                    id: 'clip_sweep_' + Date.now(), name: 'スウィープ',
                    buffer: fxBuf, startTime: Math.max(0, pos - dur), duration: fxBuf.duration, offset: 0
                };
                sweepTrack.clips.push(sweepClip);
                sweepTrack.clips[0].startTime = Math.max(0, pos - dur);
                this._renderClip(sweepTrack, sweepClip);
                this._updateTrackHeader(sweepTrack);
                this._updateMixerUI();
                this._hideLoading();
                this._toast('スウィープを新トラックに追加しました', 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });

        // 6. ビルドアップFX
        document.getElementById('btn-buildup-fx')?.addEventListener('click', async () => {
            const style = document.querySelector('#buildup-style-chips .preset-chip.active')?.dataset.val || 'riser';
            const dur = parseInt(document.getElementById('buildup-duration').value);
            this._showLoading('ビルドアップFX生成中...');
            try {
                const fxBuf = await this.proTools.generateBuildupFX(dur, style);
                const fxTrack = this.addTrack(style === 'riser' ? 'ライザーFX' : 'ドラムロールFX');
                const fxClip = {
                    id: 'clip_fx_' + Date.now(), name: style === 'riser' ? 'ライザー' : 'ドラムロール',
                    buffer: fxBuf, startTime: 0, duration: fxBuf.duration, offset: 0
                };
                fxTrack.clips.push(fxClip);
                this._renderClip(fxTrack, fxClip);
                this._updateTrackHeader(fxTrack);
                this._updateMixerUI();
                this._hideLoading();
                this._toast('ビルドアップFXを新トラックに追加しました', 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });

        // 7. スマート分割
        document.getElementById('btn-auto-segment')?.addEventListener('click', async () => {
            const tc = getClip(); if (!tc) return;
            const dur = tc.clip.buffer.duration;
            const n = parseInt(document.querySelector('#segment-count-chips .preset-chip.active')?.dataset.val || '4');

            // 最低限必要な長さチェック（1分割あたり10秒以上推奨）
            if (dur < n * 10) {
                this._toast(`曲が短すぎます（${dur.toFixed(0)}秒）。${n}分割には${n * 10}秒以上の音源が必要です`, 'error');
                return;
            }

            this._showLoading('波形を分析中...');
            try {
                const segments = this.proTools.autoSegment(tc.clip.buffer, n);

                // 分割できなかった場合（1セグメントのみ返ってきた）
                if (segments.length < 2) {
                    this._hideLoading();
                    this._toast('エネルギー変化が少なく自動分割できませんでした。曲全体が均一なため分割点が検出されませんでした', 'error');
                    return;
                }

                // 要求より少ない分割数になった場合も通知
                if (segments.length < n) {
                    this._toast(`明確な区切りが${segments.length}箇所のみ検出されました（要求: ${n}分割）`, 'info');
                }

                const segTrack = this.addTrack(tc.track.name + ' [分割]');
                const labels = ['Aメロ', 'Bメロ', 'サビ', 'Cメロ', 'ブリッジ', 'アウトロ', 'イントロ', 'ソロ'];
                segments.forEach((seg, i) => {
                    const segBuf = this.proTools.extractSegment(tc.clip.buffer, seg.start, seg.end);
                    if (!segBuf) return;
                    const segClip = {
                        id: 'clip_seg_' + Date.now() + '_' + i,
                        name: labels[i % labels.length],
                        buffer: segBuf, startTime: seg.start, duration: segBuf.duration, offset: 0
                    };
                    segTrack.clips.push(segClip);
                    this._renderClip(segTrack, segClip);
                });
                this._updateTrackHeader(segTrack);
                this._updateMixerUI();
                this._hideLoading();
                this._toast(`${segments.length}セクションに分割しました`, 'success');
            } catch (e) { this._hideLoading(); this._toast('エラー: ' + e.message, 'error'); }
        });
    }

    // ============================================
    // EVENT LISTENERS (Advanced features)
    // ============================================

    _setupEventListeners() {
        // Transport
        const playBtn = document.getElementById('btn-play');
        const _setPlayIcon  = () => { playBtn.innerHTML = '<i class="fas fa-play"></i>';  playBtn.classList.remove('active'); playBtn.title = '再生'; };
        const _setPauseIcon = () => { playBtn.innerHTML = '<i class="fas fa-pause"></i>'; playBtn.classList.add('active');    playBtn.title = '一時停止'; };

        playBtn.addEventListener('click', () => {
            this.audioEngine.resume();
            if (this.audioEngine.isPlaying) {
                // 再生中 → 一時停止（現在位置を保持）
                this.audioEngine.pause();
                _setPlayIcon();
            } else {
                // 停止 or 一時停止中 → 再生 / 再開
                this.audioEngine.play(this.tracks);
                this._scheduleAllFxClips();
                _setPauseIcon();
            }
        });
        document.getElementById('btn-stop').addEventListener('click', () => {
            this.audioEngine.stop();
            _setPlayIcon();
            this._updatePlayhead(0);
            // タイムラインを先頭にスクロール
            const container = document.getElementById('tracks-container');
            if (container) container.scrollLeft = 0;
        });
        document.getElementById('btn-rewind').addEventListener('click', () => {
            this.audioEngine.seek(0);
            this._updatePlayhead(0);
            // タイムラインを先頭にスクロール
            const container = document.getElementById('tracks-container');
            if (container) container.scrollLeft = 0;
        });
        document.getElementById('btn-forward').addEventListener('click', () => {
            const cur = this.audioEngine.getCurrentTime();
            const next = cur + 10;
            this.audioEngine.seek(next);
            this._updatePlayhead(next);
        });
        document.getElementById('btn-loop').addEventListener('click', (e) => {
            this.audioEngine.loopEnabled = !this.audioEngine.loopEnabled;
            e.currentTarget.classList.toggle('active', this.audioEngine.loopEnabled);
        });

        document.getElementById('btn-undo').addEventListener('click', () => this._undo());
        document.getElementById('btn-redo').addEventListener('click', () => this._redo());
        this._updateUndoButtons();

        document.getElementById('btn-add-track').addEventListener('click', () => {
            this.addTrack();
            this._toast('トラックを追加しました', 'info');
        });

        document.getElementById('btn-import-audio').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });

        document.getElementById('file-input').addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await this.importAndSeparate(e.target.files[0]);
                e.target.value = '';
            }
        });

        document.getElementById('btn-import-multiple').addEventListener('click', () => {
            document.getElementById('file-input-multiple').click();
        });
        document.getElementById('file-input-multiple').addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await this.importMultipleForRemix(Array.from(e.target.files));
                e.target.value = '';
            }
        });

        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentTool = btn.dataset.tool;
            });
        });

        document.querySelectorAll('.bottom-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.bottom-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.bottom-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
                if (tab.dataset.panel === 'automation') this.automation.draw();
            });
        });

        // ボトムパネルのドラッグリサイズ
        const bottomPanel = document.getElementById('bottom-panel');
        const resizeHandle = document.querySelector('.bottom-panel-resize-handle');
        if (resizeHandle && bottomPanel) {
            let isDragging = false, startY = 0, startH = 0;
            resizeHandle.addEventListener('mousedown', (e) => {
                isDragging = true; startY = e.clientY; startH = bottomPanel.offsetHeight;
                e.preventDefault();
            });
            document.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                const dy = startY - e.clientY;
                const newH = Math.max(40, Math.min(500, startH + dy));
                bottomPanel.style.height = newH + 'px';
            });
            document.addEventListener('mouseup', () => { isDragging = false; });
        }

        // ボトムパネルのトグルボタン
        const btnToggleBottom = document.getElementById('btn-toggle-bottom-panel');
        if (btnToggleBottom && bottomPanel) {
            btnToggleBottom.addEventListener('click', () => {
                const collapsed = bottomPanel.classList.toggle('collapsed');
                btnToggleBottom.innerHTML = collapsed
                    ? '<i class="fas fa-chevron-up"></i>'
                    : '<i class="fas fa-chevron-down"></i>';
            });
        }

        // Master volume
        document.getElementById('master-volume').addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.audioEngine.setMasterVolume(val);
            const db = val === 0 ? '-∞' : (20 * Math.log10(val)).toFixed(1);
            document.getElementById('master-volume-label').textContent = db + ' dB';
        });

        // Master EQ
        document.querySelectorAll('.master-eq').forEach(slider => {
            slider.addEventListener('input', (e) => {
                this.audioEngine.setMasterEQ(e.target.dataset.band, parseFloat(e.target.value));
                e.target.closest('.eq-band').querySelector('.eq-value').textContent = e.target.value + ' dB';
            });
        });

        // Compressor
        ['threshold', 'ratio', 'attack', 'release'].forEach(param => {
            const el = document.getElementById('master-comp-' + param);
            if (el) el.addEventListener('input', (e) => {
                this.audioEngine.setMasterCompressor(param, parseFloat(e.target.value));
                const label = e.target.closest('.ctrl-group').querySelector('.ctrl-value');
                if (param === 'ratio') label.textContent = e.target.value + ':1';
                else if (param === 'attack' || param === 'release') label.textContent = e.target.value + ' ms';
                else label.textContent = e.target.value + ' dB';
            });
        });

        // Limiter
        ['ceiling', 'gain'].forEach(param => {
            const el = document.getElementById('master-limiter-' + param);
            if (el) el.addEventListener('input', (e) => {
                this.audioEngine.setMasterLimiter(param, parseFloat(e.target.value));
                e.target.closest('.ctrl-group').querySelector('.ctrl-value').textContent = e.target.value + ' dB';
            });
        });

        document.getElementById('master-stereo-width').addEventListener('input', (e) => {
            e.target.closest('.ctrl-group').querySelector('.ctrl-value').textContent = e.target.value + '%';
        });

        document.getElementById('mastering-preset').addEventListener('change', (e) => {
            if (e.target.value === 'none') return;
            const values = this.mastering.applyPreset(e.target.value);
            if (values) {
                this._updateMasteringUI(values);
                this._toast(`マスタリングプリセットを適用しました`, 'success');
            }
        });

        // Vocal sliders
        ['vocal-pitch-strength', 'vocal-pitch-speed', 'vocal-denoise', 'vocal-deesser', 'vocal-presence', 'vocal-breath', 'vocal-reverb', 'vocal-delay', 'vocal-doubling'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', (e) => {
                const label = e.target.closest('.ctrl-group')?.querySelector('.ctrl-value');
                if (label) {
                    if (id.includes('presence')) label.textContent = (e.target.value > 0 ? '+' : '') + e.target.value + ' dB';
                    else if (id.includes('speed')) label.textContent = e.target.value + ' ms';
                    else label.textContent = e.target.value + '%';
                }
            });
        });

        document.getElementById('vocal-preset').addEventListener('change', (e) => {
            if (e.target.value === 'none') return;
            const settings = this.vocalProcessor.applyPreset(e.target.value);
            if (settings) { this._updateVocalUI(settings); this._toast('ボーカルプリセット適用', 'success'); }
        });

        document.getElementById('btn-vocal-enhance').addEventListener('click', async () => {
            if (!this.selectedTrack || this.selectedTrack.clips.length === 0) {
                this._showAIInfoOrError('vocal'); return;
            }
            this._showLoading('ボーカル処理中...');
            try {
                const clip = this.selectedTrack.clips[0];
                clip.buffer = await this.vocalProcessor.processVocal(clip.buffer, this._getVocalSettings());
                this._renderClip(this.selectedTrack, clip);
                this._hideLoading();
                this._toast('ボーカル処理が完了しました', 'success');
            } catch (err) { this._hideLoading(); this._toast('処理エラー: ' + err.message, 'error'); }
        });

        // Voice change
        const voiceChangeHandler = async (direction) => {
            if (!this.selectedTrack || this.selectedTrack.clips.length === 0) {
                this._toast('ボーカルトラックを選択してください', 'error'); return;
            }
            const amount = parseFloat(document.getElementById('voice-change-amount').value);
            const semitones = direction === 'female' ? amount : -amount;
            const label = direction === 'female' ? '男声→女声' : '女声→男声';
            this._showLoading(`${label} 変換中...`);
            try {
                const clip = this.selectedTrack.clips[0];
                clip.buffer = await this.vocalProcessor.changeGender(clip.buffer, semitones);
                this._renderClip(this.selectedTrack, clip);
                this._hideLoading();
                this._toast(`${label} 変換完了`, 'success');
            } catch (err) { this._hideLoading(); this._toast('変換エラー: ' + err.message, 'error'); }
        };
        document.getElementById('btn-voice-to-female').addEventListener('click', () => voiceChangeHandler('female'));
        document.getElementById('btn-voice-to-male').addEventListener('click', () => voiceChangeHandler('male'));
        document.getElementById('voice-change-amount').addEventListener('input', (e) => {
            e.target.closest('.ctrl-group').querySelector('.ctrl-value').textContent = e.target.value + ' 半音';
        });

        // AI機能の説明コンテンツ
        const _aiInfo = {
            stem: {
                title: '<i class="fas fa-project-diagram"></i> 音源分離（ステム分離）',
                body: `
                    <div class="ai-info-section">
                        <div class="ai-info-status working"><i class="fas fa-check-circle"></i> 動作中</div>
                        <p>選択したトラックの音声を周波数帯域で自動分析し、<strong>ボーカル・ドラム・ベース・その他</strong>の4パートに分割します。</p>
                        <div class="ai-info-usecases">
                            <h4>できること</h4>
                            <ul>
                                <li>🎤 ボーカルだけをミュートして「カラオケ版」を作る</li>
                                <li>🥁 ドラムだけを取り出して練習素材にする</li>
                                <li>🎸 各パートの音量を個別に調整してリミックス</li>
                                <li>🎹 特定のパートにエフェクトをかける</li>
                            </ul>
                        </div>
                        <div class="ai-info-note">
                            <i class="fas fa-info-circle"></i>
                            周波数フィルタ方式のため、完全な分離ではなく「強調」に近い処理です。精度を求める場合はかんたんモードの「ボーカル除去」スライダーをお使いください。
                        </div>
                        <button class="ai-info-action-btn" id="ai-info-do-stem">
                            <i class="fas fa-project-diagram"></i> 音源分離を実行
                        </button>
                    </div>`
            },
            midi: {
                title: '<i class="fas fa-keyboard"></i> MIDI変換',
                body: `
                    <div class="ai-info-section">
                        <div class="ai-info-status working"><i class="fas fa-check-circle"></i> 動作中（単音メロディ向け）</div>
                        <p>選択したトラックの音声を解析し、<strong>音程（ピッチ）を検出してMIDIファイル（.mid）</strong>として書き出します。</p>
                        <div class="ai-info-usecases">
                            <h4>できること・使いみち</h4>
                            <ul>
                                <li>🎹 メロディをDAWに取り込んでアレンジし直す</li>
                                <li>📝 耳コピした音程をMIDI化して楽譜ソフトで確認</li>
                                <li>🎸 ギターやシンセのフレーズをMIDIに変換</li>
                                <li>🔄 違う音色で同じメロディを鳴らす（ピアノ→ストリングスなど）</li>
                            </ul>
                        </div>
                        <div class="ai-info-note">
                            <i class="fas fa-info-circle"></i>
                            <strong>得意なもの：</strong>単音メロディ（ボーカル・フルート・ギターのメロライン）<br>
                            <strong>苦手なもの：</strong>複数の音が同時に鳴るコード・ドラム・ノイズが多い音源<br>
                            変換後のMIDIはお使いのDAW（GarageBand, FL Studio等）で開けます。
                        </div>
                        <button class="ai-info-action-btn" id="ai-info-do-midi">
                            <i class="fas fa-keyboard"></i> MIDI変換を実行
                        </button>
                    </div>`
            },
            vocal: {
                title: '<i class="fas fa-microphone"></i> ボーカル強化',
                body: `
                    <div class="ai-info-section">
                        <div class="ai-info-status working"><i class="fas fa-check-circle"></i> 動作中</div>
                        <p>選択したトラックのボーカル音声に<strong>ノイズ除去・ピッチ補正・明瞭度向上</strong>などの処理を行います。</p>
                        <div class="ai-info-usecases">
                            <h4>できること</h4>
                            <ul>
                                <li>🎤 音程のズレを自動的に補正（オートチューン）</li>
                                <li>🔇 バックグラウンドノイズを軽減</li>
                                <li>✨ 歯擦音（シャリシャリ音）を除去</li>
                                <li>🔊 ボーカルの存在感・明瞭度を上げる</li>
                            </ul>
                        </div>
                        <div class="ai-info-note">
                            <i class="fas fa-info-circle"></i>
                            下の「ボーカル補正」タブで各パラメータを調整してから「ボーカル強化」ボタンを押すと処理が適用されます。処理は不可逆です（元に戻せません）。
                        </div>
                        <button class="ai-info-action-btn" id="ai-info-do-vocal">
                            <i class="fas fa-microphone"></i> ボーカル強化パネルを開く
                        </button>
                    </div>`
            }
        };

        const _showAIInfo = (type) => {
            const info = _aiInfo[type];
            if (!info) return;
            document.getElementById('ai-info-title').innerHTML = info.title;
            document.getElementById('ai-info-body').innerHTML = info.body;
            document.getElementById('modal-ai-info').classList.remove('hidden');

            // アクションボタン
            const doStem  = document.getElementById('ai-info-do-stem');
            const doMidi  = document.getElementById('ai-info-do-midi');
            const doVocal = document.getElementById('ai-info-do-vocal');
            if (doStem) doStem.addEventListener('click', () => {
                document.getElementById('modal-ai-info').classList.add('hidden');
                if (!this.selectedTrack || this.selectedTrack.clips.length === 0) { this._toast('トラックを選択してください', 'error'); return; }
                document.getElementById('modal-stem').classList.remove('hidden');
            });
            if (doMidi) doMidi.addEventListener('click', () => {
                document.getElementById('modal-ai-info').classList.add('hidden');
                document.getElementById('btn-midi-convert').dispatchEvent(new MouseEvent('click', {bubbles:true}));
            });
            if (doVocal) doVocal.addEventListener('click', () => {
                document.getElementById('modal-ai-info').classList.add('hidden');
                document.querySelector('[data-panel="vocal"]')?.click();
            });
        };

        // AI機能ボタン：右クリック or ダブルクリックで説明モーダル
        document.querySelectorAll('.ai-feature-btn').forEach(btn => {
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                _showAIInfo(btn.dataset.ai);
            });
            // シングルクリックでも「?」マーク付きのとき
        });
        document.getElementById('btn-ai-help').addEventListener('click', () => _showAIInfo('midi'));

        // Stem split
        document.getElementById('btn-stem-split').addEventListener('click', () => {
            if (!this.selectedTrack || this.selectedTrack.clips.length === 0) { this._showAIInfoOrError('stem'); return; }
            document.getElementById('modal-stem').classList.remove('hidden');
        });
        document.getElementById('btn-do-stem-split').addEventListener('click', async () => {
            const clip = this.selectedTrack?.clips[0];
            if (!clip) return;
            const options = {
                vocals: document.querySelector('[data-stem="vocals"]').checked,
                drums: document.querySelector('[data-stem="drums"]').checked,
                bass: document.querySelector('[data-stem="bass"]').checked,
                other: document.querySelector('[data-stem="other"]').checked,
                onProgress: (pct, text) => {
                    document.querySelector('#stem-progress .progress-fill').style.width = pct + '%';
                    document.querySelector('#stem-progress .progress-text').textContent = text;
                }
            };
            document.getElementById('stem-progress').classList.remove('hidden');
            try {
                const stems = await this.stemSeparator.separate(clip.buffer, options);
                document.getElementById('modal-stem').classList.add('hidden');
                document.getElementById('stem-progress').classList.add('hidden');
                const stemNames = { vocals: 'ボーカル', drums: 'ドラム', bass: 'ベース', other: 'その他' };
                const stemColors = { vocals: '#e94560', drums: '#eab308', bass: '#22c55e', other: '#a855f7' };
                Object.keys(stems).forEach(stemName => {
                    const newTrack = this.addTrack(`${clip.name} - ${stemNames[stemName]}`);
                    newTrack.color = stemColors[stemName];
                    const newClip = { id: 'clip_' + Date.now() + '_' + stemName, name: `${clip.name} - ${stemNames[stemName]}`, buffer: stems[stemName], startTime: 0, duration: stems[stemName].duration, offset: 0 };
                    newTrack.clips.push(newClip);
                    this._renderClip(newTrack, newClip);
                    this._updateTrackHeader(newTrack);
                });
                this._updateMixerUI();
                this._toast('音源分離完了！', 'success');
            } catch (err) { document.getElementById('stem-progress').classList.add('hidden'); this._toast('分離エラー: ' + err.message, 'error'); }
        });

        // MIDI
        document.getElementById('btn-midi-convert').addEventListener('click', async () => {
            if (!this.selectedTrack || this.selectedTrack.clips.length === 0) { this._showAIInfoOrError('midi'); return; }
            this._showLoading('MIDI変換中...');
            try {
                const clip = this.selectedTrack.clips[0];
                const result = await this.midiConverter.convertToMIDI(clip.buffer, { bpm: parseInt(document.getElementById('bpm-input').value) || 120 });
                this._hideLoading();
                const a = document.createElement('a'); a.href = result.midiUrl; a.download = clip.name + '.mid'; a.click();
                this._toast(`MIDI変換完了 (${result.notes.length}ノート)`, 'success');
            } catch (err) { this._hideLoading(); this._toast('MIDI変換エラー: ' + err.message, 'error'); }
        });

        // Effects
        document.getElementById('btn-add-effect').addEventListener('click', () => {
            if (!this.selectedTrack) { this._toast('トラックを選択してください', 'error'); return; }
            document.getElementById('modal-effects').classList.remove('hidden');
        });
        document.querySelectorAll('.effect-card').forEach(card => {
            card.addEventListener('click', () => {
                if (!this.selectedTrack) return;
                this.effects.addEffectToTrack(this.selectedTrack.id, card.dataset.effect);
                document.getElementById('modal-effects').classList.add('hidden');
                this._updateEffectsPanel(this.selectedTrack);
                this._toast(`${card.querySelector('span').textContent}を追加しました`, 'success');
            });
        });

        // Automation
        document.getElementById('automation-param').addEventListener('change', (e) => this.automation.setParam(e.target.value));
        document.getElementById('automation-track').addEventListener('change', (e) => this.automation.setTrack(e.target.value));
        document.getElementById('btn-auto-clear').addEventListener('click', () => { this.automation.clearPoints(); this._toast('クリア', 'info'); });
        document.getElementById('btn-auto-smooth').addEventListener('click', () => { this.automation.smoothPoints(); this._toast('スムーズ化', 'info'); });

        // Remix
        document.getElementById('crossfade-duration').addEventListener('input', (e) => {
            this.remix.crossfadeDuration = parseFloat(e.target.value);
            document.getElementById('crossfade-value').textContent = parseFloat(e.target.value).toFixed(1) + '秒';
        });
        document.getElementById('crossfade-type').addEventListener('change', (e) => { this.remix.crossfadeType = e.target.value; });
        document.getElementById('btn-remix-add').addEventListener('click', () => document.getElementById('file-input-multiple').click());
        document.getElementById('btn-remix-auto').addEventListener('click', () => {
            if (this.remix.songs.length < 2) { this._toast('2曲以上追加してください', 'error'); return; }
            // Re-sort sequence by energy (low→high) without rendering
            const analyses = this.remix.songs.map(song => ({
                song, energy: this.remix._analyzeEnergy(song.buffer)
            }));
            analyses.sort((a, b) => a.energy - b.energy);
            this.remix.sequence = analyses.map(a => ({
                songId: a.song.id, startTrim: 0, endTrim: a.song.duration
            }));
            this._updateRemixRailUI();
            this._toast('エネルギー順に並び替えました', 'success');
        });

        document.getElementById('btn-remix-export').addEventListener('click', async () => {
            if (this.remix.sequence.length === 0) { this._toast('レールに曲を接続してください', 'error'); return; }
            this._showLoading('レールをレンダリング中...');
            try {
                const mixedBuffer = await this.remix.renderMix();
                if (mixedBuffer) {
                    const track = this.addTrack('リミックス');
                    const clip = { id: 'clip_remix_' + Date.now(), name: 'リミックス', buffer: mixedBuffer, startTime: 0, duration: mixedBuffer.duration, offset: 0 };
                    track.clips.push(clip);
                    this._renderClip(track, clip);
                    this._updateTrackHeader(track);
                    this._updateMixerUI();
                    this._toast('レールをトラックに追加しました！', 'success');
                }
                this._hideLoading();
            } catch (err) { this._hideLoading(); this._toast('レンダリングエラー: ' + err.message, 'error'); }
        });

        this._setupProToolsListeners();

        // Export
        document.getElementById('btn-export').addEventListener('click', () => document.getElementById('modal-export').classList.remove('hidden'));
        document.getElementById('album-art-preview').addEventListener('click', () => document.getElementById('album-art-input').click());
        document.getElementById('album-art-input').addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                const url = await this.exportManager.setAlbumArt(e.target.files[0]);
                document.getElementById('album-art-preview').innerHTML = `<img src="${url}" alt="Art">`;
                document.getElementById('btn-remove-art').classList.remove('hidden');
            }
        });
        document.getElementById('btn-remove-art').addEventListener('click', () => {
            this.exportManager.removeAlbumArt();
            document.getElementById('album-art-preview').innerHTML = `<i class="fas fa-image"></i><span>画像を選択</span>`;
            document.getElementById('btn-remove-art').classList.add('hidden');
        });
        document.getElementById('btn-do-export').addEventListener('click', async () => {
            this._showLoading('書き出し中...');
            try {
                const options = {
                    format: document.getElementById('export-format').value,
                    sampleRate: parseInt(document.getElementById('export-samplerate').value),
                    bitDepth: parseInt(document.getElementById('export-bitdepth').value),
                    normalize: document.getElementById('export-normalize').checked,
                    metadata: {
                        title: document.getElementById('export-title').value,
                        artist: document.getElementById('export-artist').value,
                        album: document.getElementById('export-album').value
                    }
                };
                const result = await this.exportManager.exportAudio(this.tracks, options);
                if (result) {
                    this.exportManager.downloadFile(result.url, result.fileName);
                    document.getElementById('modal-export').classList.add('hidden');
                    this._toast('書き出し完了！', 'success');
                    this._setStep(3);
                } else { this._toast('書き出すオーディオがありません', 'error'); }
                this._hideLoading();
            } catch (err) { this._hideLoading(); this._toast('書き出しエラー: ' + err.message, 'error'); }
        });

        // Modal closes
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => btn.closest('.modal').classList.add('hidden'));
        });
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
        });

        document.getElementById('bpm-input').addEventListener('input', (e) => {
            const newBpm = parseInt(e.target.value) || 120;
            if (newBpm < 20 || newBpm > 300) return;
            this.audioEngine.bpm = newBpm;
            this.audioEngine.bpmRatio = newBpm / (this.audioEngine.originalBpm || 120);
            // 再生中なら即座にすべてのソースに速度を反映
            if (this.audioEngine.isPlaying) {
                this.audioEngine.sources.forEach(src => {
                    try { src.playbackRate.value = this.audioEngine.bpmRatio; } catch(_) {}
                });
            }
            // BPMラベルに変化率を表示
            const ratio = this.audioEngine.bpmRatio;
            const pct = ((ratio - 1) * 100).toFixed(0);
            const sign = pct >= 0 ? '+' : '';
            e.target.title = `元BPM: ${this.audioEngine.originalBpm || 120} | 速度: ${sign}${pct}% (ピッチも変わります)`;
        });

        document.getElementById('timeline-ruler').addEventListener('click', (e) => {
            const x = e.clientX - e.currentTarget.getBoundingClientRect().left + this.scrollOffset;
            const time = x / this.pixelsPerSecond;
            this.audioEngine.seek(time);
            this._updatePlayhead(time);
        });

        document.getElementById('tracks-container').addEventListener('scroll', () => {
            this.scrollOffset = document.getElementById('tracks-container').scrollLeft;
            this._updateRuler();
            const time = this.audioEngine.getCurrentTime();
            document.getElementById('playhead').style.left = (180 + time * this.pixelsPerSecond - this.scrollOffset) + 'px';
        });

        // ── ズーム操作 ──────────────────────────────────────────
        // スライダー値 0-100 を 25-800 px/s に対数マッピング
        const _sliderToPps = v => Math.round(25 * Math.pow(800 / 25, v / 100));
        const _ppsToSlider = p => Math.round(Math.log(p / 25) / Math.log(800 / 25) * 100);

        const zoomSlider = document.getElementById('zoom-slider');
        zoomSlider.addEventListener('input', () => {
            this._setZoom(_sliderToPps(parseInt(zoomSlider.value)));
        });
        document.getElementById('btn-zoom-in').addEventListener('click', () => {
            const v = Math.min(100, parseInt(zoomSlider.value) + 10);
            zoomSlider.value = v;
            this._setZoom(_sliderToPps(v));
        });
        document.getElementById('btn-zoom-out').addEventListener('click', () => {
            const v = Math.max(0, parseInt(zoomSlider.value) - 10);
            zoomSlider.value = v;
            this._setZoom(_sliderToPps(v));
        });

        // Ctrl + マウスホイールでズーム
        document.getElementById('tracks-container').addEventListener('wheel', (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const slider = document.getElementById('zoom-slider');
            const delta = e.deltaY > 0 ? -5 : 5;
            const v = Math.max(0, Math.min(100, parseInt(slider.value) + delta));
            slider.value = v;
            this._setZoom(_sliderToPps(v));
        }, { passive: false });

        // キーボードショートカット（上級者モード表示中のみ）
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (this.easyMode) return;
            const slider = document.getElementById('zoom-slider');
            if (e.key === '=' || e.key === '+') {
                const v = Math.min(100, parseInt(slider.value) + 10);
                slider.value = v;
                this._setZoom(_sliderToPps(v));
            } else if (e.key === '-' || e.key === '_') {
                const v = Math.max(0, parseInt(slider.value) - 10);
                slider.value = v;
                this._setZoom(_sliderToPps(v));
            } else if (e.key === 'ArrowRight' && !e.shiftKey && !e.ctrlKey) {
                const cur = this.audioEngine.getCurrentTime();
                this.audioEngine.seek(cur + 10);
                this._updatePlayhead(cur + 10);
            } else if (e.key === 'ArrowLeft' && !e.shiftKey && !e.ctrlKey) {
                const cur = this.audioEngine.getCurrentTime();
                this.audioEngine.seek(Math.max(0, cur - 10));
                this._updatePlayhead(Math.max(0, cur - 10));
            }
        });
    }

    _setupDragDrop() {
        const app = document.getElementById('app');
        const dropZone = document.getElementById('drop-zone');
        let dragCounter = 0;

        const hideDropZone = () => {
            dragCounter = 0;
            dropZone.classList.add('hidden');
        };

        app.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            dropZone.classList.remove('hidden');
        });
        app.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) hideDropZone();
        });
        app.addEventListener('dragover', (e) => e.preventDefault());
        app.addEventListener('drop', async (e) => {
            e.preventDefault();
            hideDropZone();
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/'));
            if (files.length > 1) await this.importMultipleForRemix(files);
            else if (files.length === 1) await this.importAndSeparate(files[0]);
        });

        // ドラッグがウィンドウ外で終了した場合にも確実に閉じる
        document.addEventListener('dragend', hideDropZone);
        window.addEventListener('focus', hideDropZone);
    }

    _setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    document.getElementById('btn-play').click();
                    break;
                case 'KeyZ':
                    if (e.ctrlKey || e.metaKey) { e.preventDefault(); document.getElementById('btn-undo').click(); }
                    break;
                case 'KeyY':
                    if (e.ctrlKey || e.metaKey) { e.preventDefault(); document.getElementById('btn-redo').click(); }
                    break;
                case 'Home': this.audioEngine.seek(0); this._updatePlayhead(0); break;
                case 'End': {
                    let maxDur = 0;
                    this.tracks.forEach(t => t.clips.forEach(c => {
                        const end = (c.startTime || 0) + (c.duration || 0);
                        if (end > maxDur) maxDur = end;
                    }));
                    this.audioEngine.seek(maxDur); this._updatePlayhead(maxDur);
                    break;
                }
                case 'KeyL':
                    if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); document.getElementById('btn-loop')?.click(); }
                    break;
                case 'Escape':
                    // 開いているモーダルを閉じる／A/B比較を停止
                    document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
                    document.getElementById('btn-ab-stop')?.click();
                    document.getElementById('shortcut-help')?.remove();
                    break;
                case 'Slash':
                    if (e.shiftKey) { e.preventDefault(); this._toggleShortcutHelp(); }
                    break;
                case 'Delete': case 'Backspace':
                    if (this.selectedClip && this.selectedTrack) {
                        const idx = this.selectedTrack.clips.indexOf(this.selectedClip);
                        if (idx >= 0) {
                            this._pushUndo();
                            this.selectedTrack.clips.splice(idx, 1);
                            document.querySelector(`[data-clip-id="${this.selectedClip.id}"]`)?.remove();
                            this.selectedClip = null;
                            this._toast('クリップ削除', 'info');
                        }
                    }
                    break;
            }
        });
    }

    /** ショートカット一覧オーバーレイの表示/非表示（? キー） */
    _toggleShortcutHelp() {
        const existing = document.getElementById('shortcut-help');
        if (existing) { existing.remove(); return; }
        const rows = [
            ['Space', '再生 / 一時停止'],
            ['Home / End', '先頭 / 末尾へ移動'],
            ['← / →', '10秒 戻る / 進む'],
            ['+ / -', 'ズーム 拡大 / 縮小'],
            ['L', 'ループ オン/オフ'],
            ['Ctrl + Z / Y', '元に戻す / やり直し'],
            ['Delete / Backspace', '選択クリップを削除'],
            ['Esc', 'モーダルを閉じる / A・B停止'],
            ['Shift + ?', 'このヘルプを表示'],
        ];
        const overlay = document.createElement('div');
        overlay.id = 'shortcut-help';
        overlay.innerHTML = `
            <div class="shortcut-help-box">
                <div class="shortcut-help-title">⌨️ キーボードショートカット</div>
                ${rows.map(([k, d]) => `<div class="shortcut-help-row"><kbd>${k}</kbd><span>${d}</span></div>`).join('')}
                <div class="shortcut-help-hint">もう一度 Shift + ? または Esc で閉じる</div>
            </div>`;
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    }

    _getVocalSettings() {
        return {
            pitchStrength: parseInt(document.getElementById('vocal-pitch-strength').value),
            pitchSpeed: parseInt(document.getElementById('vocal-pitch-speed').value),
            key: document.getElementById('vocal-key').value,
            scale: document.getElementById('vocal-scale').value,
            denoise: parseInt(document.getElementById('vocal-denoise').value),
            deesser: parseInt(document.getElementById('vocal-deesser').value),
            presence: parseFloat(document.getElementById('vocal-presence').value),
            breathRemoval: parseInt(document.getElementById('vocal-breath').value),
            reverb: parseInt(document.getElementById('vocal-reverb').value),
            delay: parseInt(document.getElementById('vocal-delay').value),
            doubling: parseInt(document.getElementById('vocal-doubling').value),
            harmony: document.getElementById('vocal-harmony').value
        };
    }

    _updateMasteringUI(values) {
        ['low', 'lowmid', 'mid', 'highmid', 'high'].forEach(band => {
            const el = document.querySelector(`[data-band="${band}"]`);
            if (el) { el.value = values[band]; el.closest('.eq-band').querySelector('.eq-value').textContent = values[band] + ' dB'; }
        });
        ['threshold', 'ratio', 'attack', 'release'].forEach(p => {
            const el = document.getElementById('master-comp-' + p);
            if (el && values[p] !== undefined) {
                el.value = values[p];
                const label = el.closest('.ctrl-group').querySelector('.ctrl-value');
                if (p === 'ratio') label.textContent = values[p] + ':1';
                else if (p === 'attack' || p === 'release') label.textContent = values[p] + ' ms';
                else label.textContent = values[p] + ' dB';
            }
        });
        if (values.ceiling !== undefined) { document.getElementById('master-limiter-ceiling').value = values.ceiling; }
        if (values.gain !== undefined) { document.getElementById('master-limiter-gain').value = values.gain; }
        if (values.width !== undefined) {
            document.getElementById('master-stereo-width').value = values.width;
            document.querySelector('#master-stereo-width').closest('.ctrl-group').querySelector('.ctrl-value').textContent = values.width + '%';
        }
    }

    _updateVocalUI(settings) {
        const map = { denoise: 'vocal-denoise', deesser: 'vocal-deesser', presence: 'vocal-presence', breathRemoval: 'vocal-breath', reverb: 'vocal-reverb', delay: 'vocal-delay', doubling: 'vocal-doubling', pitchStrength: 'vocal-pitch-strength', pitchSpeed: 'vocal-pitch-speed' };
        Object.entries(map).forEach(([key, id]) => {
            if (settings[key] !== undefined) document.getElementById(id).value = settings[key];
        });
    }

    async _createDemoProject() {
        this._toast('デモプロジェクトを作成中...', 'info');
        const ctx = this.audioEngine.ctx;
        const sr = ctx.sampleRate;

        // Clear existing
        const oldIds = this.tracks.map(t => t.id);
        oldIds.forEach(id => this.removeTrack(id));

        const createBuffer = (fn) => {
            const buf = ctx.createBuffer(2, sr * 4, sr);
            for (let ch = 0; ch < 2; ch++) fn(buf.getChannelData(ch), ch);
            return buf;
        };

        const melodyBuf = createBuffer((data, ch) => {
            [261.63, 329.63, 392.00, 523.25, 392.00, 329.63, 261.63, 329.63].forEach((freq, n) => {
                const s = Math.floor(n * 0.5 * sr), e = Math.floor((n + 1) * 0.5 * sr);
                for (let i = s; i < e && i < data.length; i++) {
                    const t = (i - s) / sr, env = Math.exp(-t * 3);
                    data[i] += Math.sin(2 * Math.PI * freq * t) * 0.3 * env + Math.sin(2 * Math.PI * freq * 2 * t) * 0.1 * env;
                }
            });
        });

        const bassBuf = createBuffer((data) => {
            [130.81, 130.81, 164.81, 164.81, 196.00, 196.00, 130.81, 130.81].forEach((freq, n) => {
                const s = Math.floor(n * 0.5 * sr), e = Math.floor((n + 1) * 0.5 * sr);
                for (let i = s; i < e && i < data.length; i++) {
                    const t = (i - s) / sr;
                    data[i] += Math.sin(2 * Math.PI * freq * t) * 0.4 * Math.exp(-t * 2);
                }
            });
        });

        const drumBuf = createBuffer((data) => {
            for (let beat = 0; beat < 8; beat++) {
                const s = Math.floor(beat * 0.5 * sr);
                for (let i = 0; i < 2000 && s + i < data.length; i++) {
                    const t = i / sr;
                    data[s + i] += beat % 2 === 0 ?
                        Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 40) * 0.5 :
                        (Math.random() * 2 - 1) * Math.exp(-t * 20) * 0.3;
                }
            }
        });

        const padBuf = createBuffer((data, ch) => {
            for (let i = 0; i < data.length; i++) {
                const t = i / sr, env = Math.sin(Math.PI * t / 4) * 0.15;
                [261.63, 329.63, 392.00].forEach(freq => {
                    data[i] += Math.sin(2 * Math.PI * freq * t + ch * 0.3) * env;
                });
            }
        });

        const demos = [
            { name: '🎤 ボーカル（メロディ）', buffer: melodyBuf, color: '#ec4899' },
            { name: '🥁 ドラム', buffer: drumBuf, color: '#eab308' },
            { name: '🎸 ベース', buffer: bassBuf, color: '#22c55e' },
            { name: '🎹 その他（パッド）', buffer: padBuf, color: '#a855f7' }
        ];

        demos.forEach(demo => {
            const track = this.addTrack(demo.name);
            track.color = demo.color;
            const trackDiv = document.querySelector(`[data-track-id="${track.id}"].track`);
            if (trackDiv) trackDiv.querySelector('.track-color').style.background = demo.color;
            const clip = { id: 'clip_demo_' + Date.now() + '_' + Math.random(), name: demo.name, buffer: demo.buffer, startTime: 0, duration: demo.buffer.duration, offset: 0 };
            track.clips.push(clip);
            this._renderClip(track, clip);
            this._updateTrackHeader(track);
        });

        this._updateMixerUI();
        this._updateRuler();

        if (this.easyMode) this._renderEasyCards();

        // デモは保存しない（毎回生成するものなので）
        this._toast('デモプロジェクトを作成しました！Spaceキーまたは▶ボタンで再生してみましょう', 'success');
    }

    // ============================================
    // SAVE / RESTORE PROJECT
    // ============================================

    /** プロジェクトを自動保存 */
    /** キー(調)を検出して表示（音は変えない・失敗しても無視） */
    async _detectAndShowKey(buffer) {
        const el = document.getElementById('key-display');
        if (el) el.textContent = '...';
        try {
            const res = await this.proTools.detectKey(buffer);
            if (el) {
                el.textContent = res.key;
                el.title = `推定キー: ${res.key}（信頼度 ${res.confidence}）`;
            }
        } catch (e) {
            if (el) el.textContent = '--';
        }
    }

    async _saveProject() {
        if (!this.storage) return;
        try {
            // トラックのメタ情報を保存
            const trackMeta = this.tracks.map(t => ({
                id: t.id,
                name: t.name,
                color: t.color,
                volume: t.volume,
                pan: t.pan,
                muted: t.muted,
                solo: t.solo,
                isAIMix: t._isAIMix || false,
                isReference: t._isReference || false,
                fxClips: (t.fxClips || []).map(f => ({ id: f.id, type: f.type, startTime: f.startTime, duration: f.duration })),
                clips: t.clips.map(c => ({
                    id: c.id,
                    name: c.name,
                    startTime: c.startTime,
                    duration: c.duration,
                    offset: c.offset || 0,
                    gain: c._gain ?? 1.0,
                    audioId: c.id   // IndexedDBのキーとして使用
                }))
            }));

            await this.storage.saveProject({
                tracks: trackMeta,
                bpm: this.audioEngine.bpm || 120,
                originalBpm: this.audioEngine.originalBpm || 120,
                version: '1.0'
            });

            // 各クリップの音声データを保存（まだ未保存のもの）
            for (const track of this.tracks) {
                for (const clip of track.clips) {
                    if (clip.buffer && !clip._saved) {
                        await this.storage.saveAudioBuffer(clip.id, clip.buffer, {
                            name: clip.name,
                            trackId: track.id
                        });
                        clip._saved = true;
                    }
                }
            }

            this._updateStorageIndicator();
        } catch (err) {
            console.warn('自動保存エラー:', err);
        }
    }

    /** 保存済みプロジェクトを復元 */
    async _restoreProject() {
        if (!this.storage) return false;
        try {
            const project = await this.storage.loadProject();
            if (!project || !project.tracks || project.tracks.length === 0) return false;

            const tracksWithAudio = project.tracks.filter(t => t.clips && t.clips.length > 0);
            if (tracksWithAudio.length === 0) return false;

            this._showLoading('前回のプロジェクトを復元中...');

            for (const trackMeta of project.tracks) {
                const track = this.addTrack(trackMeta.name);
                track.color = trackMeta.color || track.color;
                track.volume = trackMeta.volume ?? 0.85;
                track.pan = trackMeta.pan ?? 0;
                track.muted = trackMeta.muted ?? false;
                track.nodes.gainNode.gain.value = track.muted ? 0 : track.volume;
                track.nodes.panNode.pan.value = track.pan;
                track._isAIMix = trackMeta.isAIMix || false;
                track._isReference = trackMeta.isReference || false;

                // カラー更新
                const trackDiv = document.querySelector(`[data-track-id="${track.id}"].track`);
                if (trackDiv) trackDiv.querySelector('.track-color').style.background = track.color;

                // 音声データを復元
                for (const clipMeta of (trackMeta.clips || [])) {
                    const result = await this.storage.loadAudioBuffer(clipMeta.audioId, this.audioEngine.ctx);
                    if (!result) continue;

                    const clip = {
                        id: clipMeta.id,
                        name: clipMeta.name,
                        buffer: result.buffer,
                        startTime: clipMeta.startTime || 0,
                        duration: clipMeta.duration || result.buffer.duration,
                        offset: clipMeta.offset || 0,
                        _gain: clipMeta.gain ?? 1.0,
                        _saved: true
                    };
                    track.clips.push(clip);
                    // M/S処理のために元バッファを保持
                    if (track._isAIMix && !track._msOriginalBuffer) {
                        track._msOriginalBuffer = result.buffer;
                    }
                    this._renderClip(track, clip);
                    this._updateTrackHeader(track);
                }

                // FXクリップ（フィルタースウィープ等）を復元
                if (trackMeta.fxClips && trackMeta.fxClips.length) {
                    track.fxClips = trackMeta.fxClips.map(f => ({
                        id: f.id, type: f.type, startTime: f.startTime, duration: f.duration
                    }));
                    this._renderFxLane?.(track);
                }
            }

            // BPMを復元（originalBpm と bpmRatio も正しく設定）
            if (project.bpm) {
                this.audioEngine.bpm         = project.bpm;
                this.audioEngine.originalBpm = project.originalBpm || project.bpm;
                this.audioEngine.bpmRatio    = project.bpm / (project.originalBpm || project.bpm);
                document.getElementById('bpm-input').value = project.bpm;
            }

            this._updateRuler();
            this._updateMixerUI();
            this._updateAutomationTrackSelect();
            this._hideLoading();

            if (this.easyMode) this._renderEasyCards();

            this._toast('前回のプロジェクトを復元しました', 'success');
            return true;
        } catch (err) {
            console.warn('復元エラー:', err);
            this._hideLoading();
            return false;
        }
    }

    async _updateStorageIndicator() {
        if (!this.storage) return;
        const usage = await this.storage.getUsage();
        if (!usage) return;

        // ストレージ情報をトースト or 常時表示
        const existing = document.getElementById('storage-indicator');
        if (existing) {
            existing.textContent = `💾 ${usage.usedMB} MB 使用中`;
            existing.title = `ブラウザ保存: ${usage.usedMB} MB / ${usage.quotaMB} MB (${usage.percent}%)`;
        }
    }

    _showLoading(text) {
        document.getElementById('loading-text').textContent = text || '処理中...';
        document.getElementById('loading-overlay').classList.remove('hidden');
    }

    _hideLoading() {
        document.getElementById('loading-overlay').classList.add('hidden');
    }

    /** AI機能ボタンを押したときにトラック未選択なら説明モーダルを出す */
    _showAIInfoOrError(type) {
        // modal-ai-info があれば説明を表示、なければトーストでエラー
        const modal = document.getElementById('modal-ai-info');
        if (modal) {
            document.getElementById('btn-ai-help')?.dispatchEvent(new MouseEvent('click', {bubbles:true}));
            // type別に表示
            const btn = document.querySelector(`.ai-feature-btn[data-ai="${type}"]`);
            if (btn) btn.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true}));
        } else {
            this._toast('トラックをクリックして選択してから実行してください', 'error');
        }
    }

    _toast(message, type = 'info', duration = 3500) {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icons = { success: 'check-circle', error: 'exclamation-circle', info: 'info-circle', warning: 'exclamation-triangle' };
        toast.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}"></i> ${escapeHtml(message)}`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
            toast.style.transition = '0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// ============================================
// 認証ゲート
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    const auth = new AuthManager();
    const loginScreen = document.getElementById('login-screen');
    const app = document.getElementById('app');

    // ログイン済みチェック
    if (auth.isLoggedIn()) {
        loginScreen.classList.add('hidden');
        startApp();
    } else {
        // ログイン画面を表示
        app.style.display = 'none';
        setupLoginForm();
    }

    function setupLoginForm() {
        const form = document.getElementById('login-form');
        const input = document.getElementById('login-password');
        const errorEl = document.getElementById('login-error');
        const btn = document.getElementById('btn-login');
        const toggleBtn = document.getElementById('btn-toggle-pw');

        // パスワード表示切替
        toggleBtn.addEventListener('click', () => {
            const isText = input.type === 'text';
            input.type = isText ? 'password' : 'text';
            toggleBtn.querySelector('i').className = 'fas fa-' + (isText ? 'eye' : 'eye-slash');
        });

        // ロックアウト状態を確認して表示
        function checkAndShowLockout() {
            const lockout = auth.getLockoutState();
            if (lockout.locked) {
                const remainMs = lockout.until - Date.now();
                const remainMin = Math.ceil(remainMs / 60000);
                errorEl.textContent = `ログイン試行回数が上限を超えました。${remainMin}分後に再試行してください。`;
                errorEl.classList.remove('hidden');
                btn.disabled = true;
                input.disabled = true;
                return true;
            }
            btn.disabled = false;
            input.disabled = false;
            return false;
        }
        checkAndShowLockout();

        // フォーム送信
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (checkAndShowLockout()) return;

            const pw = input.value.trim();
            if (!pw) return;

            btn.classList.add('loading');
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 確認中...';
            errorEl.classList.add('hidden');
            input.classList.remove('error');

            const ok = await auth.login(pw);

            if (ok) {
                loginScreen.classList.add('hidden');
                app.style.display = '';
                startApp();
            } else {
                btn.classList.remove('loading');
                btn.innerHTML = '<i class="fas fa-unlock"></i> ログイン';
                if (checkAndShowLockout()) {
                    // Lockout just triggered — message already set
                } else {
                    const lockout = auth.getLockoutState();
                    const remaining = Math.max(0, auth.MAX_ATTEMPTS - (lockout.attempts || 0));
                    errorEl.textContent = `パスワードが違います。あと${remaining}回失敗するとロックされます。`;
                    errorEl.classList.remove('hidden');
                }
                input.classList.add('error');
                input.value = '';
                input.focus();
            }
        });

        // Enterキー対応
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') form.dispatchEvent(new Event('submit'));
        });

        input.focus();
    }

    function startApp() {
        window.daw = new StudioFlowDAW();
        window.daw.init();

        // デフォルトパスワード使用中の警告
        (async () => {
            const currentHash = localStorage.getItem(auth.PW_HASH_KEY) || auth.DEFAULT_HASH;
            if (currentHash === auth.DEFAULT_HASH) {
                setTimeout(() => {
                    window.daw._toast('⚠️ デフォルトパスワードを使用中です。設定からパスワードを変更してください。', 'warning', 6000);
                }, 2000);
            }
        })();

        // ログアウトボタン
        document.getElementById('btn-logout').addEventListener('click', () => {
            if (confirm('ログアウトしますか？')) auth.logout();
        });

        // ===== 設定モーダル =====
        const settingsModal = document.getElementById('modal-settings');

        document.getElementById('btn-settings').addEventListener('click', () => {
            settingsModal.classList.remove('hidden');
            // フォームをリセット
            ['settings-pw-current','settings-pw-new','settings-pw-confirm'].forEach(id => {
                document.getElementById(id).value = '';
            });
            document.getElementById('settings-pw-error').classList.add('hidden');
            document.getElementById('settings-pw-success').classList.add('hidden');
        });

        settingsModal.querySelector('.modal-close').addEventListener('click', () => {
            settingsModal.classList.add('hidden');
        });
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) settingsModal.classList.add('hidden');
        });

        // パスワード表示切り替え
        settingsModal.querySelectorAll('.pw-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById(btn.dataset.target);
                if (!input) return;
                input.type = input.type === 'password' ? 'text' : 'password';
                btn.querySelector('i').className = input.type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
            });
        });

        // パスワード変更
        document.getElementById('btn-change-password').addEventListener('click', async () => {
            const currentPw = document.getElementById('settings-pw-current').value;
            const newPw     = document.getElementById('settings-pw-new').value;
            const confirmPw = document.getElementById('settings-pw-confirm').value;
            const errEl     = document.getElementById('settings-pw-error');
            const sucEl     = document.getElementById('settings-pw-success');
            const btn       = document.getElementById('btn-change-password');

            errEl.classList.add('hidden');
            sucEl.classList.add('hidden');

            // バリデーション
            if (!currentPw || !newPw || !confirmPw) {
                errEl.textContent = 'すべての項目を入力してください';
                errEl.classList.remove('hidden'); return;
            }
            if (newPw.length < 6) {
                errEl.textContent = '新しいパスワードは6文字以上にしてください';
                errEl.classList.remove('hidden'); return;
            }
            if (newPw !== confirmPw) {
                errEl.textContent = '新しいパスワードが一致しません';
                errEl.classList.remove('hidden'); return;
            }

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 確認中...';

            // 現在のパスワードを確認
            const currentOk = await auth.login(currentPw);
            if (!currentOk) {
                errEl.textContent = '現在のパスワードが正しくありません';
                errEl.classList.remove('hidden');
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-key"></i> パスワードを変更する';
                return;
            }

            // 新しいパスワードをlocalStorageに永続保存
            await auth.changePassword(newPw);

            sucEl.textContent = `✅ パスワードを変更しました。次回ログインから新しいパスワードが使えます。`;
            sucEl.classList.remove('hidden');

            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-key"></i> パスワードを変更する';

            // 入力欄をクリア
            ['settings-pw-current','settings-pw-new','settings-pw-confirm'].forEach(id => {
                document.getElementById(id).value = '';
            });
        });

        // 設定モーダルからのログアウト
        document.getElementById('btn-settings-logout').addEventListener('click', () => {
            if (confirm('ログアウトしますか？')) auth.logout();
        });
    }
});

// ============================================
// CREATOR ENGINE SETUP (appended to prototype)
// ============================================
StudioFlowDAW.prototype._setupCreatorListeners = function() {
    // Open creator modal
    document.getElementById('btn-easy-creator').addEventListener('click', () => {
        this._openCreatorModal();
    });

    // Close modal
    document.querySelector('#modal-creator .modal-close').addEventListener('click', () => {
        document.getElementById('modal-creator').classList.add('hidden');
    });
    document.getElementById('modal-creator').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
    });

    // Tab switching
    document.querySelectorAll('.creator-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.creator-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.creator-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('creator-panel-' + tab.dataset.tab).classList.add('active');
        });
    });

    // ① Loop settings
    document.querySelectorAll('[name="loop-end-mode"]').forEach(r => {
        r.addEventListener('change', () => {
            const manual = document.getElementById('loop-end-manual');
            manual.classList.toggle('hidden', r.value !== 'manual');
        });
    });
    document.getElementById('loop-fade-length').addEventListener('input', (e) => {
        document.getElementById('loop-fade-value').textContent = parseFloat(e.target.value).toFixed(1) + ' 秒';
    });
    document.getElementById('btn-creator-loop-process').addEventListener('click', () => this._creatorMakeLoop());
    document.getElementById('btn-creator-loop-export').addEventListener('click', () => {
        if (this._creatorLoopBuffer) this._creatorExport(this._creatorLoopBuffer, 'seamless_loop.wav');
    });

    // ② Vocal
    document.querySelectorAll('[name="vocal-method"]').forEach(r => {
        r.addEventListener('change', () => {
            const isMidSide = r.value === 'midside';
            document.getElementById('vocal-reduction-row').style.display = isMidSide ? '' : 'none';
            document.getElementById('vocal-mix-row').style.display = isMidSide ? 'none' : '';
        });
    });
    document.getElementById('vocal-reduction').addEventListener('input', (e) => {
        document.getElementById('vocal-reduction-value').textContent = Math.round(e.target.value * 100) + '%';
    });
    document.getElementById('vocal-mix-amount').addEventListener('input', (e) => {
        const pct = Math.round(e.target.value * 100);
        document.getElementById('vocal-mix-value').textContent = pct === 0 ? '0%（完全除去）' : pct + '%';
    });
    document.getElementById('btn-creator-vocal-process').addEventListener('click', () => this._creatorMakeVocal());
    document.getElementById('btn-creator-vocal-export').addEventListener('click', () => {
        if (this._creatorVocalBuffer) this._creatorExport(this._creatorVocalBuffer, 'instrumental.wav');
    });

    // ③ BPM
    document.getElementById('bpm-target').addEventListener('input', (e) => {
        const t = parseInt(e.target.value);
        document.getElementById('bpm-target-value').textContent = t + ' BPM';
        const orig = parseInt(document.getElementById('bpm-original').value) || 120;
        const ratio = t / orig;
        document.getElementById('bpm-ratio-hint').textContent = `変換比率: ${ratio.toFixed(2)}x${ratio === 1 ? '（変換なし）' : (ratio > 1 ? '（速くなります）' : '（遅くなります）')}`;
        document.querySelectorAll('.bpm-quick-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.bpm) === t));
    });
    document.getElementById('bpm-original').addEventListener('input', (e) => {
        const orig = parseInt(e.target.value) || 120;
        const t = parseInt(document.getElementById('bpm-target').value);
        const ratio = t / orig;
        document.getElementById('bpm-ratio-hint').textContent = `変換比率: ${ratio.toFixed(2)}x${ratio === 1 ? '（変換なし）' : (ratio > 1 ? '（速くなります）' : '（遅くなります）')}`;
    });
    document.querySelectorAll('.bpm-quick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const bpm = parseInt(btn.dataset.bpm);
            document.getElementById('bpm-target').value = bpm;
            document.getElementById('bpm-target-value').textContent = bpm + ' BPM';
            const orig = parseInt(document.getElementById('bpm-original').value) || 120;
            const ratio = bpm / orig;
            document.getElementById('bpm-ratio-hint').textContent = `変換比率: ${ratio.toFixed(2)}x`;
            document.querySelectorAll('.bpm-quick-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.bpm) === bpm));
        });
    });
    document.getElementById('btn-bpm-detect').addEventListener('click', () => this._creatorDetectBpm());
    document.getElementById('btn-creator-bpm-process').addEventListener('click', () => this._creatorMakeBpm());
    document.getElementById('btn-creator-bpm-export').addEventListener('click', () => {
        if (this._creatorBpmBuffer) this._creatorExport(this._creatorBpmBuffer, `bpm${document.getElementById('bpm-target').value}.wav`);
    });
};

StudioFlowDAW.prototype._openCreatorModal = function() {
    const modal = document.getElementById('modal-creator');
    modal.classList.remove('hidden');

    // Find the primary audio buffer (first non-reference track or merged)
    const buf = this._getCreatorSourceBuffer();
    const hasSource = !!buf;

    // Update source info labels
    const srcName = hasSource
        ? `音源: ${this.tracks.find(t => t.clips.length > 0)?.name || '読み込み済み'}`
        : 'まず曲をアップロードしてください';

    document.getElementById('loop-source-name').textContent = srcName;
    document.getElementById('vocal-source-name').textContent = srcName;
    document.getElementById('bpm-source-name').textContent = srcName;

    // Enable/disable buttons
    ['btn-creator-loop-process', 'btn-creator-vocal-process', 'btn-creator-bpm-process', 'btn-bpm-detect'].forEach(id => {
        document.getElementById(id).disabled = !hasSource;
    });
    const loopPreview = document.getElementById('btn-creator-loop-preview');
    if (loopPreview) loopPreview.disabled = !hasSource;
};

StudioFlowDAW.prototype._getCreatorSourceBuffer = function() {
    // Use the first track that has a clip and a buffer
    // Prefer non-reference tracks; fall back to any track with a buffer
    const track = this.tracks.find(t =>
        t.clips.length > 0 && t.clips[0].buffer &&
        !t.name.includes('参照用')
    );
    return track?.clips[0]?.buffer || null;
};

StudioFlowDAW.prototype._creatorShowProgress = function(pct, text) {
    const overlay = document.getElementById('creator-progress');
    overlay.classList.remove('hidden');
    document.getElementById('creator-progress-text').textContent = text || '処理中...';
    document.getElementById('creator-progress-fill').style.width = pct + '%';
};

StudioFlowDAW.prototype._creatorHideProgress = function() {
    document.getElementById('creator-progress').classList.add('hidden');
};

StudioFlowDAW.prototype._creatorDrawResult = function(canvasId, buffer) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !buffer) return;
    canvas.width = canvas.offsetWidth || 600;
    if (window.WaveformRenderer) {
        new WaveformRenderer().drawClipWaveform(canvas, buffer, 0, buffer.duration);
    }
};

StudioFlowDAW.prototype._creatorMakeLoop = async function() {
    const buffer = this._getCreatorSourceBuffer();
    if (!buffer) { this._toast('先に曲をアップロードしてください', 'warn'); return; }

    const modeEl = document.querySelector('[name="loop-end-mode"]:checked');
    const mode = modeEl?.value || 'auto';
    const loopEnd = mode === 'manual' ? parseFloat(document.getElementById('loop-end-sec').value) : 0;
    const fadeLength = parseFloat(document.getElementById('loop-fade-length').value);

    document.getElementById('creator-loop-result').classList.add('hidden');

    try {
        const result = await this.creator.createSeamlessLoop(buffer, {
            loopEnd,
            fadeLength,
            onProgress: (pct, text) => this._creatorShowProgress(pct, text)
        });
        this._creatorLoopBuffer = result;
        this._creatorHideProgress();

        // Show result
        const dur = result.duration;
        const mm = String(Math.floor(dur / 60)).padStart(2, '0');
        const ss = String((dur % 60).toFixed(1)).padStart(4, '0');
        document.getElementById('loop-result-duration').textContent = `長さ: ${mm}:${ss}`;
        document.getElementById('creator-loop-result').classList.remove('hidden');

        requestAnimationFrame(() => this._creatorDrawResult('loop-result-canvas', result));
        this._toast('✅ シームレスループを作成しました！', 'success');
    } catch (err) {
        this._creatorHideProgress();
        this._toast('エラー: ' + err.message, 'error');
    }
};

StudioFlowDAW.prototype._creatorMakeVocal = async function() {
    const method = document.querySelector('[name="vocal-method"]:checked')?.value || 'midside';

    document.getElementById('creator-vocal-result').classList.add('hidden');
    this._creatorShowProgress(10, 'ボーカル除去中...');

    try {
        let result;
        if (method === 'midside') {
            const buffer = this._getCreatorSourceBuffer();
            if (!buffer) throw new Error('音源が見つかりません');
            const reduction = parseFloat(document.getElementById('vocal-reduction').value);
            this._creatorShowProgress(30, 'Mid/Side処理中...');
            result = await this.creator.removeVocalMidSide(buffer, reduction);
        } else {
            // Use existing stems if available
            const stems = this._getStemsFromTracks();
            if (!stems) throw new Error('ステムが分離されていません。先にステム分離を行ってください。');
            this._creatorShowProgress(50, 'ステムミックス中...');
            const vocalMix = parseFloat(document.getElementById('vocal-mix-amount').value);
            result = await this.creator.createInstrumental(stems, { vocalMix });
        }

        this._creatorVocalBuffer = result;
        this._creatorHideProgress();

        const dur = result.duration;
        const mm = String(Math.floor(dur / 60)).padStart(2, '0');
        const ss = String((dur % 60).toFixed(1)).padStart(4, '0');
        document.getElementById('vocal-result-duration').textContent = `長さ: ${mm}:${ss}`;
        document.getElementById('creator-vocal-result').classList.remove('hidden');

        requestAnimationFrame(() => this._creatorDrawResult('vocal-result-canvas', result));
        this._toast('✅ インスト版を作成しました！', 'success');
    } catch (err) {
        this._creatorHideProgress();
        this._toast('エラー: ' + err.message, 'error');
    }
};

StudioFlowDAW.prototype._getStemsFromTracks = function() {
    const stemMap = { 'ボーカル': 'vocals', 'ドラム': 'drums', 'ベース': 'bass', 'その他': 'other' };
    const stems = {};
    this.tracks.forEach(t => {
        if (!t.clips[0]?.buffer) return;
        for (const [key, val] of Object.entries(stemMap)) {
            if (t.name.includes(key)) { stems[val] = t.clips[0].buffer; break; }
        }
    });
    return Object.keys(stems).length >= 2 ? stems : null;
};

StudioFlowDAW.prototype._creatorDetectBpm = function() {
    const buffer = this._getCreatorSourceBuffer();
    if (!buffer) { this._toast('先に曲をアップロードしてください', 'warn'); return; }

    const bpm = this.creator.detectBpm(buffer);
    document.getElementById('bpm-original').value = bpm;
    document.getElementById('bpm-target').value = bpm;
    document.getElementById('bpm-target-value').textContent = bpm + ' BPM';
    document.getElementById('bpm-ratio-hint').textContent = '変換比率: 1.00x（変換なし）';
    this._toast(`BPM自動検出: ${bpm}`, 'success');
};

StudioFlowDAW.prototype._creatorMakeBpm = async function() {
    const buffer = this._getCreatorSourceBuffer();
    if (!buffer) { this._toast('先に曲をアップロードしてください', 'warn'); return; }

    const origBpm = parseInt(document.getElementById('bpm-original').value) || 120;
    const targetBpm = parseInt(document.getElementById('bpm-target').value) || 120;

    if (origBpm === targetBpm) {
        this._toast('元BPMと変換後BPMが同じです', 'warn');
        return;
    }

    document.getElementById('creator-bpm-result').classList.add('hidden');

    try {
        const result = await this.creator.changeBpm(buffer, origBpm, targetBpm,
            (pct, text) => this._creatorShowProgress(pct, text)
        );
        this._creatorBpmBuffer = result;
        this._creatorHideProgress();

        const dur = result.duration;
        const mm = String(Math.floor(dur / 60)).padStart(2, '0');
        const ss = String((dur % 60).toFixed(1)).padStart(4, '0');
        document.getElementById('bpm-result-duration').textContent = `長さ: ${mm}:${ss}`;
        document.getElementById('bpm-result-badge').textContent = `✅ ${origBpm}→${targetBpm} BPM変換済み`;
        document.getElementById('creator-bpm-result').classList.remove('hidden');

        requestAnimationFrame(() => this._creatorDrawResult('bpm-result-canvas', result));
        this._toast(`✅ BPM ${origBpm}→${targetBpm} 変換完了！`, 'success');
    } catch (err) {
        this._creatorHideProgress();
        this._toast('エラー: ' + err.message, 'error');
    }
};

StudioFlowDAW.prototype._creatorExport = async function(buffer, filename) {
    try {
        this._creatorShowProgress(10, 'WAV書き出し中...');
        // Use export manager if available, otherwise manual WAV encode
        const wavBlob = await this._bufferToWavBlob(buffer);
        this._creatorShowProgress(90, '保存中...');
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        this._creatorHideProgress();
        this._toast('✅ 書き出し完了: ' + filename, 'success');
    } catch (err) {
        this._creatorHideProgress();
        this._toast('書き出しエラー: ' + err.message, 'error');
    }
};

StudioFlowDAW.prototype._bufferToWavBlob = function(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numSamples = buffer.length;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * blockAlign;
    const bufferSize = 44 + dataSize;

    const arrayBuf = new ArrayBuffer(bufferSize);
    const view = new DataView(arrayBuf);

    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, bufferSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, channels[ch][i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }
    }

    return Promise.resolve(new Blob([arrayBuf], { type: 'audio/wav' }));
};
