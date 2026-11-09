# HT 产品库 PWA

这是 iPhone 独立只读网页 App。程序代码与业务资料完全分开：GitHub Pages 只发布本目录的
静态程序，产品资料由用户在 iPhone 上选择 Windows/Mac 完整版导出的
`.pdbfullbackup` 文件后保存到浏览器本地。

## 本地预览

```bash
python3 -m http.server 8799 --directory pwa
```

浏览器打开 `http://127.0.0.1:8799`。必须通过 HTTP/HTTPS 访问，不能直接双击
`index.html`，否则 Service Worker 和 SQLite WebAssembly 无法正常工作。

## 发布原则

- 不得把 `.pdbfullbackup`、SQLite、产品图片或其他业务资料提交到 GitHub。
- `pwa/vendor` 中的 SQLite WebAssembly 只在手机本地读取备份。
- 解析后只保存产品、价格、成分、自定义栏目、客户报价和相关图片。
- Windows 用户、密码哈希、会话、审计记录和已生成报价文件不会进入 PWA 本地资料。
- 更新网页程序不得清除 IndexedDB 中已经导入的业务资料。

## GitHub Pages

将本目录内容发布到仓库根目录或 Pages 的发布目录。必须保留相对路径，以便项目站点
`https://<user>.github.io/<repository>/` 正常运行。
