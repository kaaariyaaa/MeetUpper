# MeetUpper

MeetUpper は、Discord サーバーでMeetUpの募集・招待から参加管理、集合情報の共有、開催前のリマインダー、アーカイブまでを扱う Bot です。サーバーメンバーなら誰でもMeetUpを作成できます。

## 主な機能

- **公開募集と招待制**: Public と Private の 2 種類のMeetUpを作成
- **参加管理**: 参加申請、主催者承認、参加者投票、招待への回答、参加キャンセル
- **非公開チャンネル**: MeetUpごとに作成し、主催者・共同主催者・参加確定者だけに公開
- **招待の代替手段**: DM を送れない場合はプライベートスレッドで招待
- **開催情報の共有**: 集合時間・集合場所を専用チャンネルで管理
- **自動リマインダー**: MeetUpごとにON/OFFと通知時刻（ONは1〜5件）を設定。プリセットまたは自由入力（最短1分前）を使え、集合時間を基準に専用チャンネルへ通知する
- **イベント連携とアーカイブ**: Public MeetUpの Discord スケジュールイベント連携、手動アーカイブ

## MeetUpの種類

| | Public | Private |
| --- | --- | --- |
| 募集方法 | `meetup募集` フォーラムに掲載 | 招待されたメンバーに案内 |
| 参加方法 | 募集投稿のボタンまたは `/meetupper apply` から申請 | 招待に回答して参加。招待を辞退した人は再申請も可能 |
| 参加の決定 | 主催者・共同主催者の承認、または参加確定者による投票 | 招待への参加回答で確定。辞退後の再申請には主催者側の承認が必要 |
| Discord スケジュールイベント | 作成時に `event: true` を指定すると連携 | 連携しない |

どちらの形式でも、集合場所などの詳細を扱う専用チャンネルは非公開です。主催者・共同主催者と参加確定者が閲覧できます。

## セットアップ

### 必要なもの

- [Bun](https://bun.sh/) 1.2 以上
- Discord アカウントと、Bot を導入するサーバーの管理者権限
- Discord Developer Portal で作成した Bot のトークン

Bot の導入には `bot` と `applications.commands` のスコープ、およびチャンネル・スレッド・イベントを管理する権限が必要です。権限の一覧と Developer Portal での設定手順は [セットアップガイド](docs/SETUP.md) を参照してください。

### 1. ソースコードを取得して依存関係をインストール

```bash
git clone https://github.com/kaaariyaaa/MeetUpper.git
cd MeetUpper
bun install
```

### 2. 環境変数を設定

```bash
cp .env.example .env
```

作成した `.env` の `DISCORD_TOKEN` に Bot トークンを設定してください。その他の設定は必要に応じて変更できます。

| 変数 | 必須 | 既定値・用途 |
| --- | --- | --- |
| `DISCORD_TOKEN` | 必須 | Discord Bot のトークン |
| `DEFAULT_TIMEZONE` | 任意 | `Asia/Tokyo`。日時入力の解釈に使用 |
| `DB_PATH` | 任意 | `data/meetupper.db`。SQLite データベースの保存先 |

### 3. Bot を起動

```bash
bun run start
```

起動すると、Bot が参加している各サーバーに `/meetupper` コマンドが登録されます。

### 4. Discord サーバーを初期化

サーバー管理者が Discord 上で次のコマンドを実行します。

```text
/meetupper init
```

`MeetUp` カテゴリ、`meetup募集` フォーラム、`招待` チャンネルが作成されます。同名のチャンネルがあれば再利用されます。その後、サーバーメンバーは `/meetupper create` でMeetUpを作成できます。

Nix / direnv を使う開発環境の準備や Discord 側の詳しい設定は [docs/SETUP.md](docs/SETUP.md) に記載しています。

## 基本的な使い方

| コマンド | 用途 |
| --- | --- |
| `/meetupper create` | MeetUpを作成する |
| `/meetupper list` | 閲覧できる開催中のMeetUpを一覧表示する |
| `/meetupper show` | MeetUpの詳細を確認する |
| `/meetupper apply` | MeetUpへの参加を申請する |
| `/meetupper invite` | メンバーを招待する |
| `/meetupper kick` | 参加確定者をMeetUpから退出させる |
| `/meetupper edit` | MeetUp名・説明・定員・開催日時を変更する |
| `/meetupper info` | 集合時間・集合場所を変更する |
| `/meetupper reminder` | 自動リマインダーのON/OFF・通知時刻（ONは1〜5件）を設定する |
| `/meetupper archive` | MeetUpを手動でアーカイブする |
| `/meetupper cancel` | MeetUpを中止する |

`meetup`（MeetUp ID）は、MeetUpの専用チャンネルや募集スレッド内で実行する場合は省略できます。

`/meetupper create` では `name`（名前）、`start`（開催日時）、`mode`（公開形式）が必須です。`capacity`（定員）は任意で、省略すると定員なしになります。開催日時は `YYYY-MM-DD HH:mm` 形式、またはタイムゾーンのオフセットを含む ISO 8601 形式で入力できます。前者は `DEFAULT_TIMEZONE` に従って解釈されます。

参加方法は `approval` で選び、`DIRECT`（直参加・既定）、`HOST`（主催者承認）、`VOTE`（参加者投票）があります。`VOTE` を選ぶ場合は `required-votes` も指定します。投票できるのは参加確定者だけなので、最初の参加確定者は主催者側から招待する必要があります。Discord スケジュールイベント連携は既定で無効です。

自動リマインダーは作成時に既定でONです（`reminder:false` で無効化）。通知時刻は既定で1日前・3時間前・30分前で、作成後に `/meetupper reminder` の専用画面で追加・変更・削除できます。ONの間は1〜5件、OFFなら0件でも構いません。

コマンドごとの権限、引数、ボタン操作は [コマンド一覧](docs/COMMANDS.md) を参照してください。

## 開発・テスト

```bash
bun run dev    # ファイル変更時に再起動
bun run check  # TypeScript の型検査
bun test       # テストの実行
bun run build  # dist/ にビルド
```

## 運用上の注意

- データは SQLite に保存します。バックアップには `DB_PATH` で指定したデータベースファイルを使用してください。
- Bot は 1 プロセスで起動してください。リマインダーはプロセス内のスケジューラで管理します。
- 自動リマインダーは専用チャンネルへ送信します。最終的に送信できなかった場合だけ、主催者・共同主催者へDMとチャンネル警告で知らせます。
- 開催日時を過ぎてもMeetUpは自動で終了・アーカイブされません。アーカイブ後も参加確定者は専用チャンネルで会話できます。
- 1 カテゴリの上限に達すると `MeetUp-2` 以降を作成してチャンネルを整理します。サーバー全体のチャンネル上限に達した場合は手動での整理が必要です。

## 関連ドキュメント

- [セットアップガイド](docs/SETUP.md): Discord 側の権限設定、開発環境、本番運用
- [リマインダー仕様](docs/REMINDERS_SPEC.md): 自動リマインダーの要件と設定画面
- [コマンド一覧](docs/COMMANDS.md): 全サブコマンドとボタン操作
- [実装上の決定事項](docs/DECISIONS.md): 設計からの変更点や細かな動作
- [動作確認チェックリスト](docs/CHECKLIST.md): 実際の Discord サーバーでの確認項目
- [全体設計書](DESIGN.md): MeetUp管理の設計方針
