# セットアップ

## 必要なもの

- Discord アカウントと、Bot を導入するサーバーの管理者権限
- Nix（flakes 有効）と direnv、または Bun 1.2 以上
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
     - Manage Threads / Create Private Threads（招待スレッド）
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
| `DISCORD_APPLICATION_ID` | 任意 | アプリケーション ID（現状は未使用） |
| `DISCORD_GUILD_ID` | 開発時推奨 | 指定するとスラッシュコマンドをそのサーバーへ即時登録する。未指定ならグローバル登録（反映に最大 1 時間） |
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

## 4. サーバーの初期レイアウト

Bot 起動時に、対象サーバーへ次のレイアウトを自動作成する。

- カテゴリ `MeetUp`
- フォーラム `オフ会募集`（MeetUp カテゴリの最上部）
- テキストチャンネル `招待`（2 番目）

既存の同名チャンネルがある場合は再利用する。カテゴリが 50 チャンネルに達した場合は、`MeetUp-2` 以降のカテゴリを自動作成してチャンネルを移動する。

## 5. コマンド登録

Bot 起動時に `/meetup` を自動登録する。`DISCORD_GUILD_ID` を設定した開発サーバーでは即時反映される。

## 6. ビルド・検査

```bash
bun run check   # TypeScript の型検査
bun test        # コアロジックのテスト
bun run build   # dist/ へバンドル
```

## 7. 本番運用のメモ

- データベースは SQLite（`data/meetupper.db`）。バックアップはこのファイルをコピーする。
- Bot を 1 プロセスだけ起動する。リマインダーはプロセス内スケジューラで動く。
- Bot を停止している間のリマインダーは、再起動後に未送信分がまとめて送信される。
- Discord の仕様上、カテゴリあたりのチャンネル上限は 50。サーバー全体の上限に達した場合は新規作成に失敗するため、その場合は手動で整理する。
