# StudioFlow DAW — 引き継ぎ書 (Session Handoff)

> このファイルは、別のセッション／別の担当が作業を引き継ぐための完全な状況説明書です。
> 新しいセッションを始めたら **まずこのファイルを読んでください**。

最終更新: 2026-05-30

---

## 0. 最重要・絶対厳守の制約

- **個人利用専用**: 「上記のシステムはほかの人に使用させず、自分のみ使用する。」
  この方針は変更しないこと。外部公開・他者利用を前提にした設計はしない。
- **完全ゼロコスト / ローカル完結**: 外部API・課金サービス・サーバー処理を一切使わない。
  すべてブラウザ内（Web Audio API / OfflineAudioContext / IndexedDB）で完結させる。
  - 検証済み: `fetch`/`XMLHttpRequest`/外部API呼び出しは **コード内に0件**。
  - `index.html` の CSP で `connect-src 'self'` を指定し、外部通信をブラウザレベルで遮断。
  - 外部読込はGoogleフォントとFont AwesomeのCDN（表示用のみ・無課金・データ送信なし）。

---

## 1. プロジェクト概要

- **何**: Suno AI生成楽曲の編集に特化した、ブラウザ完結型DAW（デジタル・オーディオ・ワークステーション）。
- **対象ユーザー**: 初心者が「プロ級」の仕上がりにできることを目指す本人専用ツール。
- **2モード構成**:
  - **かんたんモード (easyMode=true)**: 初期表示。プリセット適用・パート別操作など簡単UI。
  - **上級者モード (advanced-mode)**: トラック/クリップ編集、ミキサー、マスタリング、プロ仕上げ等。

---

## 2. デプロイ環境と「絶対に守る」運用ルール

- **ホスティング**: GitHub Pages。リポジトリ `https://github.com/kotyankotyan/studioflow.git`（branch: main）。
  公開URL: `https://kotyankotyan.github.io/studioflow/`
- **キャッシュバスティング（最重要）**:
  - `index.html` 内の全 JS/CSS 参照に `?v={短いコミットハッシュ}` を付与している（15箇所）。
  - **コードを変更したら必ず**: コード commit → そのハッシュで `?v=` を一括置換 → 別 commit「Update cache-busting version to XXXX」→ push。
  - これを怠ると GitHub Pages / ブラウザのキャッシュで古い JS/CSS が配信され、「直したのに直ってない」現象が起きる（実際に何度か発生）。
  - 置換コマンド例: `sed -i 's/?v=OLDHASH/?v=NEWHASH/g' index.html`
- **HTMLの編集は必ず Edit ツールで行う**: PowerShell の `Set-Content` 等は HTML の UTF-8/BOM を壊す。`sed -i` での `?v=` 置換は検証済みで安全（毎回 `file index.html` で UTF-8 を確認している）。
- **コミット末尾**: `Co-Authored-By: Claude <noreply@anthropic.com>` を付ける運用。

---

## 3. ファイル構成とアーキテクチャ

```
daw/
├── index.html          # 単一HTML。全UI（ログイン/かんたん/上級者/モーダル）。~1080行
├── css/styles.css      # 全スタイル
├── js/
│   ├── app.js          # ★中核(~5000行) StudioFlowDAWクラス。UI・状態・全イベント
│   ├── audio-engine.js # AudioEngine: Web Audioグラフ、再生、renderOffline(書き出し)
│   ├── pro-tools.js    # ProTools: 無音カット/フェード/オートチューン/LUFS/TruePeak/キー検出等のDSP
│   ├── auth.js         # パスワードログイン(SHA-256, localStorage)。個人用の簡易ゲート
│   ├── storage.js      # StorageManager: IndexedDBにプロジェクト&オーディオバッファを永続化
│   ├── creator.js      # 素材作成(ループ/ボーカル/BPM素材生成)、BPM検出
│   ├── automation.js   # オートメーション曲線
│   ├── effects.js / mastering.js / vocal-processor.js / remix.js
│   ├── stem-separator.js / midi-converter.js / waveform.js / export-manager.js
```

### 重要な実装ポイント
- **`window.daw`** が本物のDAWインスタンス（`window.app` はDOM要素にシャドウされるので使わない）。
- **`window.daw` はログイン後の `startApp()` クロージャ内でのみ生成**される。プレビュー検証では
  ログインせずに `new StudioFlowDAW(); await daw.init()` で手動生成してテスト可能。
- **トラック構造**: `track = { id, name, color, volume, pan, muted, solo, nodes, clips[], fxClips[], _originalBuffer/_msOriginalBuffer/_pristineBuffer }`
  - `track.nodes` = createTrackNodes() の戻り: `{ gainNode, panNode, analyser, eqLow, eqMid, eqHigh, reverbDry, reverbWet, convolver, sweepFilter }`。
    EQ/リバーブの「現在値」はこのノードの `.gain.value` 等にのみ存在（トラックに数値で持っていない場合がある）。
  - **クリップ**: `clip = { id, name, buffer, startTime, duration, offset, _gain, _saved }`。
    カット分割すると2クリップが同じ `buffer` を共有し `offset/duration` だけ変わる。
- **再生シグナルチェーン（audio-engine.js）**:
  source → gainNode(volume) → panNode → eqLow → eqMid → eqHigh →（dry + convolver/wet）→ reverbMix → sweepFilter(FX用) → analyser → masterCompressor → 5バンドmasterEQ → masterLimiter → masterGain → destination。
  - varispeed: `bpmRatio = bpm / originalBpm`。source.playbackRate に適用、時間計算も換算する。
- **書き出し `renderOffline`**: 上記チェーンをOfflineAudioContextで忠実に再現する（過去に再生と書き出しが一致しない致命バグを修正済み）。clip.offset/duration/_gain・ソロ・FXクリップ自動化・bpmRatioをすべて反映すること。
- **永続化**: `_saveProject()` がトラックメタ + 各クリップbufferをIndexedDBへ。`_restoreProject()` で復元。
  メタには `clip._gain` と `track.fxClips` も含める（含め忘れると復元時に消える）。

---

## 4. 実装済みの主な機能（すべてゼロコスト・検証済み）

- 自動ゼロクロス点カット（クリックノイズ防止、`_findZeroCrossing`）
- Suno用ワンクリッククリーンアップEQ（マスターEQプリセット、トグル）
- リファレンスEQマッチング（FFTで5バンド差分→マスターEQ）
- リアルタイム スペクトラムアナライザー / 位相相関メーター
- LUFSラウドネス正規化（ITU-R BS.1770簡易、Kウェイティング＋ゲート）
- True Peak (dBTP) メーター＆リミッター（4倍オーバーサンプリング）
- イントロ フェードイン / アウトロ フェードアウト（指数/S字/リニア）
- A/Bテイク比較（ラウドネスマッチ）＋ A/B波形オーバーレイ（差分ハイライト）
- 自動キー(調)検出（Krumhansl-Schmuckler、読み取り専用、BPM横に表示）
- Undo/Redo（スナップショット方式、`_captureState/_applyState/_pushUndo`、最大50段）
- 初期化（`_resetAllToDefaults`：カット/フェード/FX/ゲインを全取消し、pristine復元）
- キーボードショートカット（Space/Home/End/←→/+−/L/Esc/Ctrl+Z/Y/Delete、Shift+?でヘルプ）

---

## 5. 既知の不具合・注意点（次セッションで確認すべき箇所）

1. **左サイドバーのツールチップ重なり（直近で対応）**: `#left-sidebar` が `overflow-y:auto`
   のため、カスタムツールチップ `[title]:hover::after`（max-width 260px）が狭い幅に折り返して
   ボタンに重なっていた。→ `#left-sidebar [title]:hover::after { display:none }` で無効化し
   ブラウザ標準ツールチップに委譲して対処。**他の overflow:auto 領域（#bottom-panel等）でも
   同種の重なりが起きていないか要確認。**
2. **トップバーの折り返し**: `#top-bar`/`.transport-controls` は `flex-wrap:wrap`。約1040px以上は
   1段、それ未満で折り返す。`overflow:hidden`+`nowrap` に戻すと重なるので戻さないこと。
3. **「直ってない」と言われたらまずキャッシュを疑う**: `?v=` を更新したか、ユーザーに
   ハードリロード（Ctrl+Shift+R）を案内したか確認。WebFetchでライブCSS/JSの中身を直接検証できる。
4. **app.js が約5000行と巨大**: 機能追加時は該当セクションをGrepで特定してから編集する。

---

## 6. プレビュー検証の手順

1. `.claude/launch.json` に設定名 `daw`（port 8080）。`mcp__Claude_Preview__preview_start` で起動。
2. ログイン画面が出る（パスワード不明）。検証は eval で回避:
   ```js
   document.getElementById('login-screen').style.display='none';
   const app=document.getElementById('app'); app.style.display=''; app.classList.remove('hidden');
   if(!window.daw){ window.daw=new StudioFlowDAW(); await window.daw.init(); }
   document.getElementById('btn-toggle-advanced')?.click(); // 上級者モードへ
   ```
3. レイアウト検証は `preview_resize` で幅を変えて `getBoundingClientRect` の重なりを計測。
4. 変更後は必ず `location.reload()` してから再検証（クラス定義はページロード時に固定されるため）。
5. `node --check js/xxx.js` で構文チェック、`preview_console_logs level:error` でエラー0件を確認。

---

## 7. 引き継ぎ時の典型タスクの進め方

1. このHANDOFF.mdと `DEPLOY.md` を読む。
2. `git log --oneline -20` で直近の流れを把握。
3. 変更 → `node --check` → preview検証 → commit → `?v=` 更新commit → push。
4. ユーザーは日本語。簡潔・具体的に、検証結果（数値・スクショ）を添えて報告する。
