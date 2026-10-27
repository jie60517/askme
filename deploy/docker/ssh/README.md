# SSH 終端機的金鑰

不用 SSH 終端機(askme.env 的 `SSH_TERMINAL_ENABLED=0`)就不用管這個資料夾。

要用的話放兩個檔進來,容器裡會看到 `/opt/askme/ssh/<檔名>`:

- `id_ed25519`:登入目標主機用的私鑰(對應的公鑰加進目標主機那個帳號的 `~/.ssh/authorized_keys`)
- `known_hosts`:目標主機的主機金鑰,在這台主機上跑一次產生:
  `ssh-keyscan -t ed25519 <目標主機> > known_hosts`
  (目標是跑 Docker 的這台主機自己時,`<目標主機>` 填 `localhost`,再把檔案裡開頭的 `localhost` 改成 `host.docker.internal`)

私鑰的權限:`chmod 600 id_ed25519`,擁有者要是 uid 1000(容器裡的 askme)。
