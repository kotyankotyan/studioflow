# GitHub Pages へのデプロイ手順（無料・永続）

## 事前準備
GitHubアカウントが必要です → https://github.com/signup

---

## ① GitHubでリポジトリを作成

1. https://github.com/new を開く
2. 以下を入力:
   - **Repository name**: `studioflow` （任意）
   - **Public** を選択（Pages無料利用に必要）
   - `Add a README file` は **チェックしない**
3. **Create repository** をクリック

---

## ② 表示されたURLをメモ

作成後に表示される画面に以下のようなURLがあります：
```
https://github.com/あなたのユーザー名/studioflow.git
```

---

## ③ PowerShellでコマンドを実行

`C:\Users\akira\Desktop\Claude\daw` フォルダで以下を順番に実行：

```powershell
# 1. Gitリポジトリを初期化
git init

# 2. 全ファイルをステージング
git add .

# 3. 最初のコミット
git commit -m "Initial commit: StudioFlow DAW"

# 4. mainブランチに設定
git branch -M main

# 5. GitHubリポジトリと連携（URLを自分のものに変更）
git remote add origin https://github.com/あなたのユーザー名/studioflow.git

# 6. プッシュ
git push -u origin main
```

---

## ④ GitHub Pagesを有効化

1. GitHubのリポジトリページを開く
2. 上部タブの **Settings** をクリック
3. 左サイドバーの **Pages** をクリック
4. **Source** を `Deploy from a branch` に設定
5. **Branch** を `main` / `/ (root)` に設定
6. **Save** をクリック

---

## ⑤ 完成！

数分後に以下のURLでアクセスできます：
```
https://あなたのユーザー名.github.io/studioflow/
```

このURLを誰かに送れば、スマホ・PCどこからでも使えます。

---

## 更新方法（後でコードを変えたとき）

```powershell
git add .
git commit -m "更新内容のメモ"
git push
```
→ 数秒〜数分でサイトに反映されます。

---

## データについて

- アップロードした音声データは **ブラウザのIndexedDB** に保存されます
- **同じブラウザ・同じURL** でアクセスすれば次回も復元されます
- 別のブラウザ・別のデバイスからは復元されません（ブラウザ内保存のため）
- 完全なクラウド保存が必要な場合は別途サーバーが必要です
