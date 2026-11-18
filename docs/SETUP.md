# セットアップ

## 必要なもの

- Discord アカウントと、Bot を導入するサーバーの管理者権限
- Nix（flakes 有効）と direnv + nix-direnv、または Bun 1.2 以上
- GitHub への push 権限（リポジトリ運用時のみ）

## 1. Discord アプリケーションを作る

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** を作成する。
2. **Bot** タブで Bot を追加し、トークンを発行する。
3. **OAuth2** タブの **URL Generator** で次のスコープと権限を選び、生成された URL からサーバーへ導入する。
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions:
     - View Channels
     - Send Messages
     - Embed Links
     - Read Message History
     - Manage Channels（専用チャンネルの作成・権限設定・移動）
     - Manage Roles（チャンネル権限の上書きに必要）
     - Manage Threads / Create Public Threads / Create Private Threads（募集フォーラム投稿・招待スレッド。カテゴリ権限の設定にも必要）
     - Send Messages in Threads（招待スレッド・募集投稿への返信）
     - Create Events（外部スケジュールイベントの作成）
     - Manage Events（スケジュールイベントの変更）
     - Mention Everyone は不要
4. Bot の **Privileged Gateway Intents** はすべて無効のままで動作する（Guilds intent のみ使用）。

## 2. 環境変数

`.env.example` を `.env` にコピーし、値を設定する。

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` | 必須 | Bot トークン |
| `DEFAULT_TIMEZONE` | 任意 | `YYYY-MM-DD HH:mm` 入力の解釈に使うタイムゾーン。既定は `Asia/Tokyo` |
| `DB_PATH` | 任意 | SQLite ファイルのパス。既定は `data/meetupper.db` |

## 3. 依存関係と起動

direnv を使う場合:

```bash
direnv allow
bun install
cp .env.example .env   # 値を編集
bun run start
```

direnv を使わない場合:

```bash
nix develop
bun install
bun run start
```

開発中は `bun run dev`（ファイル変更で再起動）を使う。

## 4. サーバーの初期セットアップ

Bot をサーバーへ導入したら、サーバー管理者が `/meetupper init` を実行する。まず作成・再利用するチャンネルを確認パネル（ephemeral）に表示し、「実行する」を押すと次のレイアウトを作成する。

- カテゴリ `MeetUp`
- フォーラム `meetup募集`（MeetUp カテゴリの最上部）
- テキストチャンネル `招待`（2 番目）

既存の同名チャンネルがある場合は再利用し、権限と並び順を整える。`/meetupper init` は管理者権限を持つユーザーだけが実行できる。セットアップ前に `/meetupper create` や `/meetupper invite` を実行すると、init を促すメッセージが返る。

初期化後、メンバーは `/meetupper create` の作成モーダル（公開モード・参加方法・MeetUp名・開催日時）からMeetUpを作成できる。定員・説明・集合情報などは作成後の `/meetupper edit` で設定する。

あとから `MeetUp` カテゴリの権限を変更する場合、Bot に「チャンネルを見る」「チャンネルを管理」を残すこと。外すと Bot は配下のチャンネルを見失い、`/meetupper init` を実行してもセットアップ未完了と表示される（その場合は権限を戻してから init を再実行する）。

カテゴリが 50 チャンネルに達した場合は、`MeetUp-2` 以降のカテゴリを自動作成してチャンネルを移動する。

## 5. コマンド登録

Bot が参加している各サーバーへ `/meetupper` を起動時に登録する。以後サーバーへ追加されたときも自動で登録する。スラッシュコマンドの引数は任意の対象MeetUp（`[meetup]`）だけで、その他の設定は画面のボタン・セレクトメニュー・モーダルから行う。

## 6. ビルド・検査

```bash
bun run check   # TypeScript の型検査
bun test        # コアロジックのテスト
bun run build   # dist/ へバンドル
```

## 7. 本番運用のメモ

- データベースは SQLite（`data/meetupper.db`）。バックアップはこのファイルをコピーする。
- Bot を 1 プロセスだけ起動する。リマインダーはプロセス内スケジューラで動く。
- Bot 停止中に予定時刻を過ぎたリマインダーは、再起動後に予定時刻から15分以内かつ通知基準日時より前のものだけ送信する。期限切れは送信せず、スキップとして履歴に残す。
- 送信に失敗した場合は1分・2分・4分・8分後に再試行する（通知予定時刻から15分以内）。最終的に失敗した場合は主催者・共同主催者へDMし、DM失敗時は専用チャンネルへ1件の警告を送る（失敗から24時間以内）。
- Discord の仕様上、カテゴリあたりのチャンネル上限は 50。サーバー全体の上限に達した場合は新規作成に失敗するため、その場合は手動で整理する。
