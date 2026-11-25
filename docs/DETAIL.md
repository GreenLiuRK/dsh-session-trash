# 会话回收站

DSH 的会话侧栏只有「归档会话」，归档只是把对话藏起来：日志还在 `~/.dsh/sessions` 里，磁盘空间一点没省。这个插件给 DSH 补上真正意义上的删除，并且默认走可恢复的回收站。

## 三种动作

- **移入回收站**：会话从侧栏移除，日志目录整体移动到 `~/.dsh/session-trash/<时间戳>-<会话 id>/session`，投影缓存副本存在同一条目的 `projection.json`。回收站索引写在 `~/.dsh/session-trash/index.json`。
- **还原**：把日志移回它原来的项目目录（`~/.dsh/sessions/<项目>/<会话 id>/`），把投影缓存副本放回 `storages/session_projcache/sessions/`，再把会话重新挂回原工作区，然后从索引里删掉这条记录。标题与工作区归属随之恢复。
- **彻底删除**：会话文件先按原大小用随机字节覆写一遍并 `fsync`，再整棵目录删除；不写回收站条目，索引里也不会留下痕迹。

右键任意会话行，菜单里能看到「移入回收站 / 彻底删除… / 回收站」。管理面板列出每条记录的原工作区、删除时间和大小，支持逐条处理与一键清空。

## 删除为什么不只是 `rm`

DSH 在内存里同时持有会话、Agent、持久化 writer 和投影缓存四份状态。只删文件会留下：

- 侧栏里点开就报错的幽灵行；
- 仍握着已删文件句柄的 writer（Windows 上文件删不掉）；
- 下次启动时用旧检查点重建出内容不完整的会话。

所以删除按宿主自己的收尾顺序走：取消 Agent → 等待空闲 → `flush()` → 从 session store `detach()`（顺带广播 `host/session-removed`，界面当场刷新）→ 关闭 writer → 从工作区账目、归档集合、置顶集合移除 → 删投影缓存 → 移动或粉碎文件。

## 逐条说明

| 步骤 | 调用 | 缺失时的降级 |
| --- | --- | --- |
| 取消工作 | `agent.cancel({ kind: 'disposed' })` + `agent.whenIdle()` | 记录 warning，继续 |
| 落盘与下线 | `sessions.flush()`、`sessions.store.get(id).detach()` | 记录 warning，继续 |
| 释放 writer | `persistence.tracker` 的 writer / openHandles | 文件仍被占用时删除会失败并如实报错 |
| 工作区账目 | `workspaceRegistry.list()` → `entity.detachSession(id)` | 记录 warning，条目留在"未分组" |
| 归档 / 置顶集合 | `registry.enqueueOperation` + `setState` | 记录 warning |
| 投影缓存 | `sessionProjectionCache` 的 table `delete` + 移走 per-record 文件并保留副本 | 记录 warning，会话首次打开时由宿主重建 |
| 文件 | `rename`（跨卷时 copy + `rm`）或覆写后 `rm` | 失败原样报错，回收站索引不写入 |

## 安全约束

- 会话 id 会过白名单校验（不允许路径分隔符、`..`、控制字符）。
- 会话目录必须真的位于 `<DSH_HOME>/sessions/<项目>/<会话>` 两层之下，且不是符号链接 / junction；否则拒绝操作。
- 还原时会校验记录里的原路径仍在会话根目录之内，且目标未被占用。
- 同一会话 / 同一条目的操作串行执行，两个入口（菜单与面板）不会互相踩。

## 已知限制

- 只处理会话日志与投影缓存。附件库、费用账本、调试日志不在范围内。
- 子智能体会话不会级联删除。
- 覆写删除在 SSD / CoW / 有快照的卷上不保证物理擦除。
- 依赖宿主的若干内部结构，升级 DSH 后若改名，会降级并留下 warning，而不是中断删除。
