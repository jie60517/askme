# 用 Docker 在內網一台主機跑 AskME

## 需要什麼

- 一台 Linux 主機(4 核 / 8 GB 以上),裝好 Docker 與 Docker Compose(`docker compose version` 有輸出)
- Claude 的訂閱帳號(Pro / Max),或一把 API key(<https://console.anthropic.com> 申請)—— 差別見最後一節
- 要讓 AI 回答的專案原始碼

## 第一次安裝

在 repo 根目錄:

```bash
docker build -f deploy/docker/Dockerfile -t askme:local .
cd deploy/docker
cp .env.example .env
cp askme.env.example askme.env
cp knowledge_bases.example.json knowledge_bases.json
```

編輯 `.env`:填 `PG_PASSWORD`(一串長的亂數);用 API key 的話把 `CLAUDE_AUTH` 改成 `apikey` 並填 `ANTHROPIC_API_KEY`。
編輯 `askme.env`:**改掉 `ADMIN_PASSWORD`**,`LOGIN_IP_ALLOWLIST` 填你們的內網網段(例 `192.168.1.0/24`)。

```bash
docker compose up -d
docker compose ps          # 三個都是 running,askme 過一會兒變 healthy
```

用訂閱帳號(`CLAUDE_AUTH=subscription`,預設)的話,登入一次:

```bash
docker compose exec -it askme claude
```

在裡面打 `/login`,照畫面開網址、登入、把代碼貼回來;看到可以問問題的畫面就打 `/exit` 離開。
登入存在 volume 裡,之後重啟、升級 image 都不用再登。

用瀏覽器開 `http://<這台主機的內網 IP>:8100`,用 `askme.env` 的管理員帳密登入,
到「Users」建同仁的帳號。先問一題範例專案的問題,確定 AI 會回答。

## 放自己的專案

1. 把專案放進 `projects/<名字>/`,再放一份 `CLAUDE.md`(照 `projects/example/CLAUDE.md` 改,只寫這個專案自己的規則 —— 網頁情境的通用規則 image 已經自動載入,不用在專案裡放 `RULES-web-context.md` 副本)
2. 重新整理網頁,輸入框旁的專案選單就會多一個 `<名字>`,不用重啟

要給專案設範例問題、預設模型、文件目錄,或把它設成新對話的預設專案,才需要改 `knowledge_bases.json`(路徑寫容器裡的 `/srv/projects/<名字>`),改完 `docker compose up -d --force-recreate askme`。

專案已經在主機別的地方:`.env` 的 `PROJECTS_DIR` 改成那個資料夾,裡面的每個子資料夾一樣自動當成專案。

## 日常

| 要做的事 | 指令(在 `deploy/docker` 裡) |
|---|---|
| 看 log | `docker compose logs -f askme` |
| 改了 `askme.env` / `knowledge_bases.json` | `docker compose up -d --force-recreate askme` |
| 更新程式 | 拉新的程式碼後 `docker build -f deploy/docker/Dockerfile -t askme:<新版號> ../..`,`.env` 的 `ASKME_TAG` 改成新版號,`docker compose up -d` |
| 退回上一版 | `.env` 的 `ASKME_TAG` 改回舊版號,`docker compose up -d` |
| 備份資料庫 | `docker compose exec postgres pg_dump -U askme askme > askme-$(date +%Y%m%d).sql` |
| 停掉 | `docker compose down`(資料在 volume 裡,不會不見;**不要加 `-v`**,那會連資料一起刪) |

## 用 http 開會少的功能

瀏覽器只在 https 或 `localhost` 開放某些功能,用內網 IP 的 http 開時這兩個會不能用:

- 筆記的「框選截圖」
- 輸入框的語音輸入

要用的話得在前面自己架一層 https(例如 nginx + 內部憑證)。nginx 設定範本是 `deploy/nginx.conf.example`
(登入限速、上傳上限、SSH 終端機的 WebSocket 都設好了),開頭寫了 `askme.env` 的 `FORWARDED_ALLOW_IPS` 要怎麼配。

`askme.env.example` 只列常用的幾條,其餘設定的完整清單與理由在 `deploy/env.server.example`。

## 訂閱帳號還是 API key

`.env` 的 `CLAUDE_AUTH` 決定,改了之後 `docker compose up -d --force-recreate askme`。

| | subscription(預設) | apikey |
|---|---|---|
| 費用 | 訂閱月費,有用量上限 | 照用量計費 |
| 誰可以用 | **只有你自己**:訂閱是個人方案,不能給別人共用 | 多人用沒問題 |
| 登入資料在哪 | askme 容器的 `~/.claude`,**AI 讀得到**(full 帳號有 Bash) | key 只在 keyproxy 容器,AI 拿不到 |

apikey 模式下,網站與 AI 所在的 `askme` 容器只有一個假值,claude 的請求經 keyproxy 補上 key 再送出。
代價是 AI 仍然可以透過 keyproxy 呼叫 API(用得到、拿不走),費用照 key 計。
