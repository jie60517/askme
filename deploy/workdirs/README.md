# 各專案的工作目錄(workdir)範本

`backend/knowledge_bases.json` 的每一筆都有一個 `workdir`:claude 子行程就在那個目錄裡起來(cwd),
所以那裡的 `CLAUDE.md`、`.claude/skills/` 會被載入,session 也存進對應的 `~/.claude/projects/` 格子。
各專案的 `CLAUDE.md` 範本是 `workspace/example/CLAUDE.md`;這個目錄只放:

- `RULES-web-context.md`:「網頁情境規則」的**正本** —— 模型被網頁服務以 headless 模式叫起來時,
  跟人坐在終端機前不一樣的那幾條(使用者看不到終端機、不能互動確認、只能寫 outputs、
  引用要附檔案:行號、回答格式)。**每個專案的 workdir 放一份副本**,`CLAUDE.md` 在檔尾用
  `@./RULES-web-context.md` 引入。
  ⚠️ 引入的檔一定要在 workdir 裡面:headless(`claude -p`)模式下,指到 workdir 外面的引入
  (`@../../…`、`@~/…`)不會被載入,規則不生效,畫面上也看不出來。
  改正本時各份副本要一起換;repo 裡的範例副本 `workspace/example/RULES-web-context.md`
  由 `backend/tests/test_rules_copy.py` 比對。
  Docker 版不用放副本:image 把正本放在 claude 的受管理記憶檔位置(`/etc/claude-code/CLAUDE.md`),
  每一題都會載入(見 `deploy/docker/Dockerfile`)。

⚠️ `workdir` 指到的目錄**必須存在**。不存在時服務不會壞:退回 `.env` 的 `CLAUDE_WORKDIR`
並在 log 留一行 warning,答案照出、但那個專案的規則與 skill 隔離沒有生效,畫面上看不出來。
啟動後掃一次服務 log 有沒有「workdir 不存在」(Docker 版:`docker compose logs askme | grep "workdir 不存在"`)。

`cwd` 底下的東西不需要 `--add-dir` 就讀得到 —— 所以一個 workdir 裡不要同時放兩個專案的樹,
也不要把上傳/產出目錄(`AGENT_KNOWLEDGE_DIR`)放在任何 workdir 底下。
