# 部署与运维

## 当前生产环境

- 服务器目录：`/home/ubuntu/kline-master`
- 对外端口：`3100`
- 进程管理：PM2，服务名 `kline-master`
- 启动入口：`server.js`
- 真实 Kimi 配置：服务器受保护的 `kline.env`，由 PM2 配置注入

不要提交或下载生产环境的真实密钥和运行时数据。

## 更新原则

先在本机或其他干净目录克隆仓库，完成语法检查和功能测试，再只同步源码文件。不要用 `rsync --delete` 清理生产目录，也不要覆盖以下文件：

```text
kline.env
wx-config.json
leaderboard.json
records.json
sessions.json
users.json
*.log
```

## 重启与验证

```bash
pm2 restart kline-master
curl -I http://127.0.0.1:3100/
curl -I http://127.0.0.1:3100/server.js
```

首页应返回 200；`/server.js` 应返回 404 或 403。涉及登录、成绩或 AI 的改动，还需分别验证对应 API。

## 运行时数据备份

运行数据不属于 Git 仓库。服务器维护时应单独备份，且不要把包含真实用户数据的备份上传到 GitHub。
