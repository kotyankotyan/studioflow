/**
 * StudioFlow Auth
 * SHA-256ハッシュによるパスワードゲート認証
 */
class AuthManager {
    constructor() {
        this.DEFAULT_HASH = '12df4b6d72b29caa72e9a6cc8bfb8d1c6c23f03b73a0d37c4f382180aed8e87c';
        this.PW_HASH_KEY = 'studioflow_pw_hash';
        this.SESSION_KEY = 'studioflow_auth';
        this.SESSION_DAYS = 7;
        // ブルートフォース対策
        this.LOCKOUT_KEY = 'studioflow_lockout';
        this.MAX_ATTEMPTS = 5;
        this.LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15分
        // localStorageに保存された変更済みハッシュがあれば使う
        this.PASSWORD_HASH = localStorage.getItem(this.PW_HASH_KEY) || this.DEFAULT_HASH;
    }

    /** パスワードをSHA-256でハッシュ化 */
    async hashPassword(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password + 'studioflow_salt_2024');
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /** ログイン済みかチェック */
    isLoggedIn() {
        const session = localStorage.getItem(this.SESSION_KEY);
        if (!session) return false;
        try {
            const { expiry } = JSON.parse(session);
            return Date.now() < expiry;
        } catch {
            return false;
        }
    }

    /** ロックアウト状態を確認 */
    getLockoutState() {
        try {
            const raw = localStorage.getItem(this.LOCKOUT_KEY);
            if (!raw) return { locked: false, attempts: 0, until: 0 };
            const state = JSON.parse(raw);
            if (state.until && Date.now() < state.until) {
                return { locked: true, attempts: state.attempts, until: state.until };
            }
            // ロックアウト期間が過ぎていたらリセット
            if (state.until && Date.now() >= state.until) {
                localStorage.removeItem(this.LOCKOUT_KEY);
                return { locked: false, attempts: 0, until: 0 };
            }
            return { locked: false, attempts: state.attempts || 0, until: 0 };
        } catch {
            return { locked: false, attempts: 0, until: 0 };
        }
    }

    /** 失敗回数を記録 */
    _recordFailedAttempt() {
        const state = this.getLockoutState();
        const attempts = (state.attempts || 0) + 1;
        if (attempts >= this.MAX_ATTEMPTS) {
            localStorage.setItem(this.LOCKOUT_KEY, JSON.stringify({
                attempts,
                until: Date.now() + this.LOCKOUT_DURATION_MS
            }));
        } else {
            localStorage.setItem(this.LOCKOUT_KEY, JSON.stringify({ attempts, until: 0 }));
        }
    }

    /** 成功時に失敗カウントをリセット */
    _clearFailedAttempts() {
        localStorage.removeItem(this.LOCKOUT_KEY);
    }

    /** パスワード認証 */
    async login(password) {
        const lockout = this.getLockoutState();
        if (lockout.locked) return false;

        const hash = await this.hashPassword(password);
        if (hash !== this.PASSWORD_HASH) {
            this._recordFailedAttempt();
            return false;
        }

        this._clearFailedAttempts();
        const expiry = Date.now() + this.SESSION_DAYS * 24 * 60 * 60 * 1000;
        localStorage.setItem(this.SESSION_KEY, JSON.stringify({ expiry }));
        return true;
    }

    /** ログアウト */
    logout() {
        localStorage.removeItem(this.SESSION_KEY);
        location.reload();
    }

    /** パスワード変更用ハッシュ生成 */
    async generateHash(newPassword) {
        return await this.hashPassword(newPassword);
    }

    /**
     * パスワードを永続的に変更する
     * 新しいハッシュをlocalStorageに保存し、以後そちらを使う
     */
    async changePassword(newPassword) {
        const newHash = await this.hashPassword(newPassword);
        this.PASSWORD_HASH = newHash;
        localStorage.setItem(this.PW_HASH_KEY, newHash);
        return newHash;
    }

}


window.AuthManager = AuthManager;
