# dsh-session-trash · 会话回收站

> 给 DeepSeek Harness 补上**真正能删对话**的能力：删进可恢复的回收站，需要时原样还原；也可以直接粉碎，不给磁盘留会话日志。

**第一次用、或者不想碰命令行？** 看 **[使用教程（一步步点哪里）](使用教程.md)** —— 从安装到误删找回，全是白话。

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-1082ff)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen)](package.json)

DSH 的会话侧栏只有「归档会话」——归档只是把对话藏起来，日志还在 `~/.dsh/sessions` 里，磁盘一点没省，而且后端也没有对应的删除接口。这个插件把删除补上，并且默认走回收站。

## 功能

| 操作 | 结果 | 能否还原 |
| --- | --- | --- |
| **移入回收站** | 会话从侧栏消失，整份日志移到 `~/.dsh/session-trash/<时间戳-id>/session`，投影缓存副本存在同条目 `projection.json` | 能，字节级原样还原回原工作区 |
| **彻底删除** | 同样的下线流程，但日志先按原大小用随机字节覆写并 `fsync`，再 unlink；不写回收站条目 | 不能 |
| **回收站面板** | 列出每条记录的原工作区、删除时间、占用大小；逐条还原 / 彻底删除，或一键清空 | — |

入口：会话侧栏右键任意对话（或行尾 `…` 菜单）→ **移入回收站 / 彻底删除… / 回收站**。

## 删除为什么不是 `rm`

删之前，DSH 在内存里同时握着会话、Agent、持久化 writer 和投影缓存四份状态。只删文件会留下：点开就报错的幽灵行、仍握着已删文件句柄的 writer（Windows 上文件删不掉）、以及下次启动用旧检查点重建出的残缺会话。

所以插件按宿主自己的收尾顺序执行：

1. `agent.cancel({ kind: 'disposed' })` 取消该会话的工作，`whenIdle()` 等它真的停下；
2. `sessions.flush()` 把缓冲事件落盘，然后 `sessions.store.get(id).detach()` —— 这一步广播 `host/session-removed`，侧栏那一行当场消失；
3. 关闭持久化 writer，释放文件句柄；
4. 从每个工作区的会话账目（`entity.detachSession`）、归档集合、置顶集合里移除该 id；
5. 把投影缓存检查点移出宿主（含生成的标题），trash 模式保留副本；
6. 移动目录（跨卷时 copy + `rm`）或覆写后删除。

还原时反向执行：目录移回原路径 → 缓存副本放回 → `attachSession` 挂回原工作区 → 清索引。

## 安装

不想看命令的话，直接跟 [使用教程 · 第三节](使用教程.md#三安装一次性大约-1-分钟) 走。

**插件市场**：搜索 `dsh-session-trash`（发布后）。

**本地目录**：Plugins → Add plugin → 选择本目录。

**命令行**（在 DSH 里直接说）：

```
把这个本地目录装成 DSH bundle：<本仓库的绝对路径>
```

装好后在侧栏右键任意会话即可看到三项菜单。

## 安全约束

- 会话 id 走白名单校验：不允许路径分隔符、`..`、控制字符、结尾的 `.` / 空格。
- 会话目录必须真的位于 `<DSH_HOME>/sessions/<项目>/<会话>` 两层之下，且不是符号链接 / junction，否则拒绝操作。
- 还原时校验记录里的原路径仍在会话根目录内，且目标未被占用。
- 同一会话 / 同一条目的操作串行执行，菜单与面板两个入口不会互相踩。
- 宿主内部结构（`sessions.store`、`persistence.tracker`、`workspaceRegistry` 记录）全部特性探测：某次 DSH 升级改名后，对应步骤降级并留 warning，而不是中断删除。

## 已知限制

- 只处理会话日志与投影缓存。附件库（`~/.dsh/attachments`）、费用账本（`cost-meter`）、调试日志不在范围内。
- 子智能体会话不级联删除，需要时单独删。
- 覆写删除在 SSD、写时复制文件系统或启用了卷影副本的机器上不保证物理擦除；本插件做的是「覆写内容 + unlink」。
- 从未落盘的空会话没有可删除的文件。

## 数据结构

```
~/.dsh/
├── sessions/<项目>/<会话>/session.v4.jsonl.zstd   # 会话日志（被移动）
├── session-trash/
│   ├── index.json                                 # 回收站索引
│   └── <时间戳>-<会话 id>/
│       ├── session/                               # 原会话目录
│       └── projection.json                        # 投影缓存副本（含标题）
└── storages/session_projcache/sessions/<id>.json  # 还原时写回
```

## 开发

```bash
npm run check     # node --check 两半
```

Host 半侧 `index.js` 提供 `/session-trash/api` 前缀路由（`list` / `trash` / `shred` / `restore` / `purge` / `empty`）；Client 半侧 `client.js` 注册会话菜单项与 `shell.overlay` 面板，两者调用同一套实现。

## License

[MIT](LICENSE)
