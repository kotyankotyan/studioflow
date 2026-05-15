/**
 * StudioFlow Storage Manager
 * IndexedDB を使って音声データ・プロジェクト設定をブラウザに永続保存します。
 * ページをリロードしても前回の状態を復元できます。
 */
class StorageManager {
    constructor() {
        this.DB_NAME = 'studioflow';
        this.DB_VERSION = 1;
        this.db = null;

        // Stores
        this.STORE_AUDIO   = 'audio_buffers';   // 音声データ（ArrayBuffer）
        this.STORE_PROJECT = 'project';          // プロジェクト設定（JSON）
        this.STORE_ASSETS  = 'assets';           // アルバムアート等
    }

    async open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_AUDIO)) {
                    db.createObjectStore(this.STORE_AUDIO, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(this.STORE_PROJECT)) {
                    db.createObjectStore(this.STORE_PROJECT, { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains(this.STORE_ASSETS)) {
                    db.createObjectStore(this.STORE_ASSETS, { keyPath: 'id' });
                }
            };

            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            req.onerror = () => reject(req.error);
        });
    }

    // ──────────────────────────────────────────
    // 音声データの保存・読み込み
    // ──────────────────────────────────────────

    /**
     * AudioBuffer → ArrayBuffer に変換してIndexedDBに保存
     * @param {string} id  - クリップID
     * @param {AudioBuffer} audioBuffer
     * @param {object} meta - { name, duration, sampleRate, numberOfChannels }
     */
    async saveAudioBuffer(id, audioBuffer, meta = {}) {
        const channels = [];
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
            channels.push(audioBuffer.getChannelData(ch).buffer.slice(0));
        }

        const record = {
            id,
            meta: {
                name: meta.name || id,
                duration: audioBuffer.duration,
                sampleRate: audioBuffer.sampleRate,
                numberOfChannels: audioBuffer.numberOfChannels,
                ...meta
            },
            channels,
            savedAt: Date.now()
        };

        return this._put(this.STORE_AUDIO, record);
    }

    /**
     * IndexedDB から AudioBuffer を復元
     * @param {string} id
     * @param {AudioContext} ctx
     * @returns {Promise<{buffer: AudioBuffer, meta: object} | null>}
     */
    async loadAudioBuffer(id, ctx) {
        const record = await this._get(this.STORE_AUDIO, id);
        if (!record) return null;

        const { meta, channels } = record;
        const audioBuffer = ctx.createBuffer(
            meta.numberOfChannels,
            Math.ceil(meta.duration * meta.sampleRate),
            meta.sampleRate
        );

        channels.forEach((ch, i) => {
            audioBuffer.getChannelData(i).set(new Float32Array(ch));
        });

        return { buffer: audioBuffer, meta };
    }

    /** 保存済み音声IDの一覧を取得 */
    async listAudioIds() {
        const all = await this._getAll(this.STORE_AUDIO);
        return all.map(r => ({ id: r.id, meta: r.meta, savedAt: r.savedAt }));
    }

    async deleteAudio(id) {
        return this._delete(this.STORE_AUDIO, id);
    }

    // ──────────────────────────────────────────
    // プロジェクト設定の保存・読み込み
    // ──────────────────────────────────────────

    async saveProject(projectData) {
        return this._put(this.STORE_PROJECT, { key: 'current', ...projectData, savedAt: Date.now() });
    }

    async loadProject() {
        return this._get(this.STORE_PROJECT, 'current');
    }

    async saveSettings(settings) {
        return this._put(this.STORE_PROJECT, { key: 'settings', settings, savedAt: Date.now() });
    }

    async loadSettings() {
        const rec = await this._get(this.STORE_PROJECT, 'settings');
        return rec ? rec.settings : null;
    }

    // ──────────────────────────────────────────
    // アセット（アルバムアート等）
    // ──────────────────────────────────────────

    async saveAsset(id, blob) {
        return this._put(this.STORE_ASSETS, { id, blob, savedAt: Date.now() });
    }

    async loadAsset(id) {
        const rec = await this._get(this.STORE_ASSETS, id);
        return rec ? rec.blob : null;
    }

    // ──────────────────────────────────────────
    // ストレージ使用量の確認
    // ──────────────────────────────────────────

    async getUsage() {
        if (!navigator.storage || !navigator.storage.estimate) return null;
        const estimate = await navigator.storage.estimate();
        return {
            used: estimate.usage || 0,
            quota: estimate.quota || 0,
            usedMB: ((estimate.usage || 0) / 1024 / 1024).toFixed(1),
            quotaMB: ((estimate.quota || 0) / 1024 / 1024).toFixed(0),
            percent: estimate.quota ? ((estimate.usage / estimate.quota) * 100).toFixed(1) : 0
        };
    }

    /** ストレージを全削除 */
    async clearAll() {
        await this._clear(this.STORE_AUDIO);
        await this._clear(this.STORE_PROJECT);
        await this._clear(this.STORE_ASSETS);
    }

    // ──────────────────────────────────────────
    // 内部ヘルパー
    // ──────────────────────────────────────────

    _transaction(storeName, mode = 'readonly') {
        return this.db.transaction([storeName], mode).objectStore(storeName);
    }

    _put(storeName, value) {
        return new Promise((resolve, reject) => {
            const req = this._transaction(storeName, 'readwrite').put(value);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    _get(storeName, key) {
        return new Promise((resolve, reject) => {
            const req = this._transaction(storeName).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    _getAll(storeName) {
        return new Promise((resolve, reject) => {
            const req = this._transaction(storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    _delete(storeName, key) {
        return new Promise((resolve, reject) => {
            const req = this._transaction(storeName, 'readwrite').delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    _clear(storeName) {
        return new Promise((resolve, reject) => {
            const req = this._transaction(storeName, 'readwrite').clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
}

window.StorageManager = StorageManager;
