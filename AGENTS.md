# Agent 维护说明

## 项目形态

这是无构建步骤的原生 JavaScript 项目。直接修改 `index.html`、`app.js`、`server.js` 和 `data/`，不要擅自引入前端框架或包管理器。

## 每次修改后

1. 执行 `node --check server.js`、`node --check app.js` 和 `node --check build-manifest.js`。
2. 题库变化时执行 `node build-manifest.js`，并同时提交两个 manifest 文件。
3. 用独立测试端口启动服务，验证首页和关键 API；不要在服务器直接手动启动生产端口。
4. 验证 `/server.js`、`/*.json` 等敏感路径不会被静态服务公开。
5. 部署后检查生产首页和关键接口，生产 PM2 服务名为 `kline-master`。

## 安全硬约束

- 严禁提交或公开 `kline.env`、真实微信配置、API Key、用户、会话、战绩、排行榜和日志。
- 不要放宽 `isStaticAllowed()` 静态白名单来“临时调试”。
- 不要把密钥移到 `app.js`、`index.html` 或 `data/` 等前端可下载文件。
- 部署同步不得覆盖线上运行时 JSON；上传 GitHub 前也要再次检查。
- `KLT_TEST=1` 只允许本地测试，生产环境不得开启。

## 业务约束

交易规则、T+1、费用、每日一题服务端复核和登录身份逻辑影响实验与榜单有效性。修改前先阅读相关实现，不要顺手改变规则。
