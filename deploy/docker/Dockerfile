# AskME 的 Docker image(內網一台主機用)。image 裡**沒有**任何部署地點的東西:
# 專案程式碼、knowledge_bases.json、askme.env、資料庫、Claude API key 全部在部署時由 compose 給。
#
# 建置脈絡是 repo 根目錄(排除清單見旁邊的 Dockerfile.dockerignore):
#   docker build -f deploy/docker/Dockerfile -t askme:<TAG> .
#
# claude 的登入有兩種(訂閱 / API key 經 keyproxy),由 .env 的 CLAUDE_AUTH 切換,見 compose.yml 與 entrypoint.py。

# ---------------------------------------------------------------- 1. 前端
FROM node:22-bookworm-slim AS frontend

WORKDIR /src/frontend

# 先裝依賴再放原始碼:只改程式時 npm ci 那一層走快取。
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------- 2. 執行層
FROM python:3.12-slim-bookworm

# 要換 claude 版本就改這裡(或 build 時 --build-arg CLAUDE_VERSION=...),然後打一個新 tag。
# 固定版本是故意的:同一個 tag 的 image 永遠是同一支 claude,退版才退得乾淨。
ARG CLAUDE_VERSION=2.1.290

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # claude 裝在 /usr/local/bin(root 的、唯讀),它自己也更新不了;關掉免得每次啟動都去試。
    DISABLE_AUTOUPDATER=1

# claude 與 full 帳號的 Bash 會用到的基本工具。容器裡沒有的指令,AI 就叫不到 —— 缺什麼補在這一行。
# /usr/bin/python3:hook 與腳本習慣寫這個路徑,image 的 python 在 /usr/local/bin。
# poppler-utils:claude 的 Read 讀大份的 PDF、或指定頁數讀,是叫 pdftoppm 把頁面轉成圖;沒有它只讀得了小份的。
# poppler-data 是 CJK 的 CMap,中文 PDF 要它才轉得對;它只是 recommends,--no-install-recommends 不會自己帶。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git less openssh-client procps ripgrep poppler-utils poppler-data \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/local/bin/python3 /usr/bin/python3

# claude CLI:官方安裝腳本裝到一個**暫時的** HOME,再把實際執行檔複製出來。
# 不能留在 /home/askme —— 那裡執行時會被 volume 蓋住,升級 image 之後 claude 就不會跟著換。
# 複製用 -L:~/.local/bin/claude 是指向 versions/<版本> 的 symlink。
# 最後那個 --version 是把關:下載到壞檔或版本號打錯,build 就在這裡失敗。
RUN export HOME=/tmp/claude-install \
 && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
 && cp -L "$HOME/.local/bin/claude" /usr/local/bin/claude \
 && chmod 755 /usr/local/bin/claude \
 && rm -rf /tmp/claude-install \
 && HOME=/tmp/claude-check /usr/local/bin/claude --version \
 && rm -rf /tmp/* /tmp/.[!.]* \
 && test -z "$(ls -A /tmp)"
# ↑ 跑完把 /tmp 清空並確認是空的:claude 會在 /tmp 留下 root 700 的目錄,
#   留在 image 裡的話執行時的 askme 刪不掉,同名目錄還會擋住它自己要建的。

# 執行身分。uid/gid 固定 1000:volume 裡的檔案擁有者跟著 uid 走,換了 uid 舊資料就讀不到。
# /home/askme 與 /app/backend/data 要先在 image 裡建好、屬於 askme ——
# 空的 named volume 第一次掛上去時會複製這個目錄的擁有者;容器 cap_drop 了 ALL,事後 chown 不回來。
RUN groupadd -g 1000 askme \
 && useradd -u 1000 -g 1000 -m -d /home/askme -s /bin/bash askme \
 && mkdir -p /app/backend/data /opt/askme/config /etc/claude-code \
 && chown askme:askme /app/backend/data

# 網頁情境規則放在 claude 的「受管理」記憶檔位置:每一題都會載入,不靠各專案的 CLAUDE.md 引入。
# 專案的 CLAUDE.md 用 @ 引入工作目錄外的檔案要先在互動畫面核准,headless(-p)下不會載入;
# 這個位置不受那條限制。root 擁有、askme 唯讀 —— AI 就算拿到 Bash 也改不了。
COPY deploy/workdirs/RULES-web-context.md /etc/claude-code/CLAUDE.md

WORKDIR /app/backend

# 先裝依賴再放程式碼:只改程式時這一層走快取。
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

# 哪些不會進來(版本清單、.env、資料、測試…)見 Dockerfile.dockerignore。
COPY backend/ ./
COPY --from=frontend /src/frontend/dist/ /app/frontend/dist/
COPY deploy/docker/entrypoint.py /app/entrypoint.py

USER askme
ENV HOME=/home/askme

EXPOSE 8100

# askme.env 的讀法見 entrypoint.py;沒給指令就跑 uvicorn(參數見 entrypoint.py 的 UVICORN)。
ENTRYPOINT ["python", "/app/entrypoint.py"]
