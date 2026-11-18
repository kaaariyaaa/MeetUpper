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
- **Discord内で完結するUI**: コマンドは対象MeetUpの指定だけ。作成・編集・招待・参加者管理はボタン・セレクトメニュー・モーダルで操作する

## MeetUpの種類

| | Public | Private |
| --- | --- | --- |
| 募集方法 | `meetup募集` フォーラムに掲載 | 招待されたメンバーに案内 |
| 参加方法 | 募集投稿のボタンまたは `/meetupper apply` から申請 | 招待に回答して参加。招待を辞退した人は再申請も可能 |
| 参加の決定 | 主催者・共同主催者の承認、または参加確定者による投票 | 招待への参加回答で確定。辞退後の再申請には主催者側の承認が必要 |
| Discord スケジュールイベント | 作成後の編集画面でONにすると連携（初期値はOFF） | 連携しない |

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

`/meetupper init` は作成・再利用するチャンネルを確認パネルに表示し、「実行する」を押すと `MeetUp` カテゴリ、`meetup募集` フォーラム、`招待` チャンネルを作成します。同名のチャンネルがあれば再利用されます。その後、サーバーメンバーは `/meetupper create` の作成モーダルからMeetUpを作成できます。

Nix / direnv を使う開発環境の準備や Discord 側の詳しい設定は [docs/SETUP.md](docs/SETUP.md) に記載しています。

## 基本的な使い方

| コマンド | 用途 |
| --- | --- |
| `/meetupper init` | サーバーのカテゴリ・フォーラム・招待チャンネルを初期化する（管理者） |
| `/meetupper create` | 作成モーダルからMeetUpを作成する |
| `/meetupper list` | 募集中 / 参加中 / 管理中を切り替えてMeetUpを探す |
| `/meetupper show [meetup]` | MeetUpの詳細と操作ボタンを表示する |
| `/meetupper apply [meetup]` | MeetUpへの参加を申請する |
| `/meetupper invite [meetup]` | ユーザーを選んで招待する |
| `/meetupper members [meetup]` | 参加者と状態の一覧を表示する（主催者側） |
| `/meetupper leave [meetup]` | 参加をキャンセルする |
| `/meetupper kick [meetup]` | 参加確定者を退出させる（主催者側） |
| `/meetupper cohost [meetup]` | 共同主催者を追加・削除する（主催者） |
| `/meetupper host [meetup]` | 主催者を変更する（主催者） |
| `/meetupper edit [meetup]` | 設定ハブで基本情報・参加方法・集合情報などを編集して保存する |
| `/meetupper info [meetup]` | 集合時間・集合場所を入力して保存する |
| `/meetupper reminder [meetup]` | 自動リマインダーのON/OFF・通知時刻を設定する |
| `/meetupper archive [meetup]` | 確認のうえMeetUpをアーカイブする |
| `/meetupper cancel [meetup]` | 確認のうえMeetUpを中止する |

`[meetup]` は任意です。MeetUpの専用チャンネルや募集スレッド内では省略でき、それ以外の場所で省略した場合は対象を選ぶ一覧が表示されます。

### 作成と編集

`/meetupper create` は1つのモーダルを開き、**公開モード（Public / Private）・参加方法（直参加 / 主催者承認 / 参加者投票）・MeetUp名・開催日時**の4項目を入力します。開催日時は `YYYY-MM-DD HH:mm` 形式で、`DEFAULT_TIMEZONE`（既定は `Asia/Tokyo`）に従って解釈されます。

作成時は定員なし・説明なし・集合情報なし・共同主催者なし・イベント連携OFF・自動リマインダーON（1日前・3時間前・30分前）で始まります。Private の参加方法は主催者承認固定です。参加者投票の必要票数は初期値1で、作成後に `/meetupper edit` で変更します。

MeetUp名・説明・定員・開催日時・参加方法・集合情報・イベント連携は `/meetupper edit` の設定ハブで編集します。変更は「保存」を押すまで反映されず、「キャンセル」で破棄されます。日時を変えるとリマインダー・スケジュールイベント・募集投稿も更新されます。

### 画面の共通ルール

すべての画面は実行者だけに表示され、15分で期限切れになります。操作のたびに実行者・ギルド・MeetUpの状態・権限を確認します。退出・キック・主催者変更・中止・アーカイブ・招待送信は確認ボタンを挟みます。

コマンドごとの権限、画面の詳細、画面間リンクは [コマンド一覧](docs/COMMANDS.md) を参照してください。

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
