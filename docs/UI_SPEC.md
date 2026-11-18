# MeetUpper UI 操作仕様

状態: 実装済み

全コマンドを Discord のボタン・セレクトメニュー・モーダル中心のUIで操作する。スラッシュコマンドの引数は MeetUp の指定だけに縮小する。

## コマンドと引数

| コマンド | 引数 | UI |
| --- | --- | --- |
| `/meetupper init` | なし | 管理者向けの確認パネル → 実行 |
| `/meetupper create` | なし | 1つのモーダル（公開モード・参加方法・MeetUp名・開催日時）→ 作成結果パネル |
| `/meetupper list` | なし | ダッシュボード（募集中 / 参加中 / 管理中を切り替え、MeetUp選択） |
| `/meetupper show` | `[meetup]` | 詳細パネル（権限に応じた操作ボタン） |
| `/meetupper apply` | `[meetup]` | 参加確認パネル。引数もチャンネルもなければ参加可能な一覧 |
| `/meetupper invite` | `[meetup]` | ユーザー選択 → 確認 → 招待DM/スレッド |
| `/meetupper members` | `[meetup]` | 参加者一覧（ページ切り替え） |
| `/meetupper leave` | `[meetup]` | キャンセル確認。文脈がなければ参加中の一覧 |
| `/meetupper kick` | `[meetup]` | 参加確定者選択 → 確認 |
| `/meetupper cohost` | `[meetup]` | 共同主催者の追加（ユーザー選択）・削除（一覧選択） |
| `/meetupper host` | `[meetup]` | 新しい主催者を選択 → 確認 |
| `/meetupper edit` | `[meetup]` | 設定ハブ。基本情報・参加方法・集合情報などを編集して保存 |
| `/meetupper info` | `[meetup]` | 集合時間・集合場所の入力モーダル → 保存 |
| `/meetupper archive` | `[meetup]` | 確認パネル |
| `/meetupper cancel` | `[meetup]` | 確認パネル |
| `/meetupper reminder` | `[meetup]` | 既存のリマインダー設定画面 |

`[meetup]` は任意。専用チャンネル・募集スレッド内では省略できる。それ以外で省略した場合は、対象を選ぶ一覧を表示する。

## 作成モーダル

- 公開モード（Public / Private）
- 参加方法（直参加 / 主催者承認 / 参加者投票）
- MeetUp名
- 開催日時（`YYYY-MM-DD HH:mm`、`DEFAULT_TIMEZONE` 基準）

初期値・作成時の固定値:

- 定員なし（0）
- 説明なし
- 集合時間・集合場所なし
- 共同主催者なし
- イベント連携OFF
- 自動リマインダーON（1日前・3時間前・30分前）
- Private の参加方法は主催者承認固定。Public は選択可（省略不可）
- 参加者投票を選んだ場合、必要票数は作成後 `/meetupper edit` で設定する（初期値1）

作成後は結果パネルに「MeetUpを開く」「編集」「リマインダー」を出す。

## 編集（保存式）

`/meetupper edit` は設定ハブを開く。編集内容はセッション内の下書きに保持し、「保存」を押した時点で一括反映する。「キャンセル」で破棄する。

編集できる項目:

- 基本情報: 名前・説明・定員・開催日時
- 参加方法: 直参加 / 主催者承認 / 参加者投票（必要票数）
- 集合情報: 集合時間・集合場所
- イベント連携: ON/OFF（Publicのみ）
- 共同主催者・主催者変更への導線
- リマインダー設定への導線

日時変更時はリマインダーを再計算し、スケジュールイベントと募集投稿も更新する。参加者への通知は従来どおり。

## セッションとカスタムID

- 複数ステップの画面は `src/core/ui.ts` のセッション（15分TTL、所有者・ギルド紐付け）を使う。
- すべてのボタン・セレクト・モーダルで、所有者・ギルド・MeetUpの状態・権限を再確認する。
- 画面はすべて ephemeral。
- 破壊的操作（退出・キック・主催者変更・中止・アーカイブ・招待送信）は確認ボタンを挟む。
- カスタムIDの名前空間:
  - 作成: `create:`
  - 一覧・詳細・参加: `browse:`
  - 編集: `edit:`
  - 招待・キック・共同主催者・主催者: `people:`
  - init・集合情報・退出・アーカイブ・中止: `ops:`
  - リマインダー: `reminder:`
- 他機能への導線用の固定ID:
  - `browse:show:<meetupId>`
  - `edit:open:<meetupId>`
  - `people:invite-open:<meetupId>`
  - `people:kick-open:<meetupId>`
  - `people:cohost-open:<meetupId>`
  - `people:host-open:<meetupId>`
  - `ops:info-open:<meetupId>`
  - `ops:leave-open:<meetupId>`
  - `ops:archive-open:<meetupId>`
  - `ops:cancel-open:<meetupId>`
  - `reminder:open:<meetupId>`
  - 参加は既存の `apply:start:<meetupId>` を使う。

## 権限

- 一覧・詳細・参加: 閲覧できるMeetUpのみ表示。Private は招待・申請・参加済みの人だけ。
- 編集・集合情報・招待・キック・共同主催者・主催者変更・アーカイブ・中止・参加者一覧: 主催者または共同主催者（一部は主催者のみ）。
- 参加キャンセル: 参加確定者本人（主催者・共同主催者は不可）。
- リマインダー: 主催者・共同主催者。
- init: サーバー管理者。

## 廃止するもの

- スラッシュコマンドの `user` / `action` / 各フィールド引数は削除する。MeetUp ID 以外の引数は持たない。
- 既存の引数ベース実装（旧 `manage.ts`）は削除し、機能ごとの UI 実装へ置き換えた。
