/**
 * StudioFlow Auth
 * SHA-256ハッシュによるパスワードゲート認証
 * デフォルトパスワード: studio2024
 */
class AuthManager {
    constructor() {
        // パスワードのSHA-256ハッシュ（変更する場合は下のメソッドで生成）
        // デフォルト: studio2024
        this.PASSWORD_HASH = '12df4b6d72b29caa72e9a6cc8bfb8d1c6c23f03b73a0d37c4f382180aed8e87c';
        this.SESSION_KEY = 'studioflow_auth';
        this.SESSION_DAYS = 7; // 7日間ログイン維持
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

    /** パスワード認証 */
    async login(password) {
        const hash = await this.hashPassword(password);
        if (hash !== this.PASSWORD_HASH) return false;

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
}

window.AuthManager = AuthManager;
