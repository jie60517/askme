# workspace

把你自己的專案放在這裡:**這個資料夾底下第一層的每一個資料夾就是一個專案**,
資料夾名就是網頁上的專案名稱。整個專案資料夾(含程式碼)複製進來,結構不用改。

```
workspace\
├─ topprod\               ← 正式區
│   ├─ CLAUDE.md          這個專案的規則(範本 deploy\workdirs\CLAUDE.template.md)
│   ├─ RULES-web-context.md   從 deploy\workdirs\ 複製一份(CLAUDE.md 用 @./RULES-web-context.md 引入)
│   ├─ .claude\skills\    專案專用的 skill(選配)
│   └─ tiptop\aap\4gl\…   程式碼本身
└─ toptest\               ← 測試區
```

放進來之後重新整理網頁就看得到,不用重啟。這裡的專案不進這個 repo(`.gitignore` 只留這份說明)。
詳細說明見 repo 根目錄 `README.md` 的〈放自己的專案〉。
