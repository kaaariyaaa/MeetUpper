# コマンド一覧

すべて `/meetupper` のサブコマンドとして提供する。

| コマンド | 実行できる人 | 内容 |
| --- | --- | --- |
| `/meetupper init` | サーバー管理者 | `MeetUp` カテゴリ・`meetup募集` フォーラム・`招待` チャンネルを作成する（既存なら再利用） |
| `/meetupper create` | サーバーメンバー全員 | MeetUpを作成する（Public / Private、承認方式、日時、集合情報、共同主催者、イベント連携。`capacity` 省略時は定員なし） |
| `/meetupper list` | メンバー全員 | ACTIVE なMeetUpの一覧を表示する（Private は招待・申請済みのものだけ表示） |
| `/meetupper show [meetup]` | 閲覧権限のある人 | MeetUpの詳細を表示する（集合場所は参加確定者と主催者側のみ） |
| `/meetupper apply [meetup]` | メンバー全員（Private は招待済みの人） | 参加申請する |
| `/meetupper invite <user> [meetup]` | 主催者・共同主催者・参加確定者 | メンバーを招待する（参加確定者の場合は主催者承認を経て DM 送信） |
| `/meetupper edit [meetup]` | 主催者・共同主催者 | MeetUp名・説明・定員・開催日時を変更する（日時変更時はリマインドとスケジュールイベントも更新し、Public は募集投稿も更新） |
| `/meetupper info [meetup]` | 主催者・共同主催者 | 集合時間・集合場所を変更して参加者へ通知する |
| `/meetupper leave [meetup]` | 参加確定者 | 参加をキャンセルする（主催者は不可） |
| `/meetupper kick <user> [meetup]` | 主催者・共同主催者 | 参加確定者をMeetUpから退出させる（専用チャンネルの権限を解除して参加者へ通知。退出させられた人は再申請できない） |
| `/meetupper members [meetup]` | 主催者・共同主催者 | 参加者と状態の一覧を表示する |
| `/meetupper cohost <user> <add\|remove> [meetup]` | 主催者 | 共同主催者を追加・削除する |
| `/meetupper host <user> [meetup]` | 主催者 | 主催者を変更する |
| `/meetupper archive [meetup]` | 主催者・共同主催者 | 確認のうえアーカイブする（ACTIVE と中止済みが対象。アーカイブ済みは不可） |
| `/meetupper cancel [meetup]` | 主催者 | 確認のうえMeetUpを中止する |
| `/meetupper remind [meetup]` | 主催者・共同主催者 | 参加確定者に今すぐリマインドを送る |

`[meetup]` は任意。MeetUpの専用チャンネル（またはその中のスレッド）や `meetup募集` の募集スレッド内で実行すると省略できる。

## ボタン操作

| 場所 | ボタン | 動作 |
| --- | --- | --- |
| 募集フォーラムの投稿 | 参加申請 | Public MeetUpへ参加申請する |
| 参加申請の通知 | 承認 / 却下 | 主催者・共同主催者が申請を裁く |
| 参加申請の通知（投票制） | 賛成票 | 参加確定者が投票する（必要票数に到達すると承認） |
| 招待 DM / 招待スレッド | 参加する / 参加しない | 招待に回答する（回答後に一時スレッドを削除） |
| 参加者からの招待申請 | 承認 / 却下 | 主催者・共同主催者が承認し、DM を送る |
| アーカイブ・中止の確認 | 実行 / やめる | 誤操作を防ぐ確認 |
| チャンネル削除後の通知 | MeetUpを中止する / ACTIVE を維持する | 削除された専用チャンネルの再作成後に選ぶ |

## 参加者投票の注意

参加者投票は Public MeetUpでのみ使う。投票できるのは参加確定者だけなので、最初の参加確定者は主催者・共同主催者が `/meetupper invite` で招待して用意する。`required-votes` は参加者投票を選ぶ場合は必須。承認済み参加者数を超える票数を設定すると承認できない。

## 参加状態

`INVITED`（招待中）、`APPLIED`（申請中）、`APPROVED`（承認済み）、`DECLINED`（辞退）、`REJECTED`（却下）、`CANCELLED`（キャンセル）。

専用チャンネルを閲覧できるのは、主催者・共同主催者・`APPROVED` の参加者・Bot のみ。
