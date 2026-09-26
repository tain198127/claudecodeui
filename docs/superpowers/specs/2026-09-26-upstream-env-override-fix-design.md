# 上游端点覆盖失效 —— 根因与修复设计

日期：2026-09-26
分支：`feat/configurable-upstreams`
上游提交：`7fd93a0c feat(upstreams): configure and switch Anthropic-compatible endpoints`

## 背景

`7fd93a0c` 引入了「可配置上游」：把端点、凭据、模型清单从 `~/.claude/settings.json` 搬进应用内的一等公民概念，并支持按会话切换。这是本机部署所需的正确方向。

但在本机（`cli.sanrenx.cn`，CloudCLI 以 root 运行）实测发现：**该功能在当前宿主环境下会静默失效** —— 在 UI 里选中一个新上游，请求仍然发往 `settings.json` 里写死的那个端点。不报错，只是走错地方。

本文记录根因、修复方案与验证方式。

## 根因

### 实测的配置优先级

在目标宿主机上用真实二进制逐项实测（`ANTHROPIC_BASE_URL` 指向必然拒绝连接的 `http://127.0.0.1:9` 作为探针）：

| 测试 | 条件 | 观察 | 结论 |
|---|---|---|---|
| T1 | 进程 env 设探针地址；`settings.json` 设真地址 | 请求成功返回 | `settings.json` 的 `env` **覆盖**进程 env |
| T2 | `settings.json` 的 `env` 清空；进程 env 设探针地址 | 请求卡住未连上 | 无冲突时进程 env **生效** |
| T3 | `--settings` 给探针地址；`settings.json` 给真地址 | 请求卡住未连上 | `--settings` **优先于**用户 `settings.json` |
| T4 | `--settings` 只给 BASE_URL/AUTH_TOKEN；`settings.json` 另设 `ANTHROPIC_MODEL` | 该模型名**依然生效** | `--settings` 的 `env` 是**按键合并**，非整体替换 |

即优先级为：**`--settings`（CLI 级） > 用户 `settings.json` > 进程环境**。

这与「环境变量最优先」的直觉相反，但符合 Claude Code 的设计：`settings.json` 是给该 CLI 用的权威配置。

### 缺陷 ①：注入通道选错了

`server/modules/providers/list/claude/claude-runtime.provider.js` 将上游配置写入**进程环境**：

```js
Object.assign(sdkOptions.env, options.upstreamEnv, { ANTHROPIC_MODEL: sdkOptions.model });
```

其注释称「base URL 和 token 会盖过宿主机环境带来的值」。由 T1 可知，**该断言在本机不成立**：`/root/.claude/settings.json` 的 `env` 中写有 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`，它们会反向覆盖进程环境。

结果：配置上游后请求仍发往宿主机 `settings.json` 指定的端点。

### 缺陷 ②：haiku 别名未被接管

同一处在接管 `ANTHROPIC_MODEL` 时，**未接管 `ANTHROPIC_DEFAULT_HAIKU_MODEL`**。二者是不同的键，由 T5 可知未被显式覆盖的键会从 `settings.json` 原样存活。

本机 `settings.json` 设有 `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash[1M]`。T4 证明的正是这一泄漏机制：探针未提供 `ANTHROPIC_MODEL`，它却依然生效；`ANTHROPIC_DEFAULT_HAIKU_MODEL` 遵循同样的语义。Claude Code 的后台小任务（标题生成、上下文压缩）走 haiku 档位，因此切到新上游后这些请求仍会携带一个该端点不认识的模型名，表现为偶发失败——不会中断主对话，容易被误判为网络抖动。

## 修复方案

改动集中在 `mapCliOptionsToSDK()` 内的上游注入块：

```js
if (options.upstreamEnv) {
  const upstreamEnv = {
    ...options.upstreamEnv,
    ANTHROPIC_MODEL: sdkOptions.model,
    // settings.json 的 haiku 别名与 ANTHROPIC_MODEL 是不同的键，
    // 不显式接管就会带着宿主模型名打到新端点。
    // 上游可通过 extraEnv 指定更便宜的档位，未指定时退回本次的模型。
    ANTHROPIC_DEFAULT_HAIKU_MODEL:
      options.upstreamEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL || sdkOptions.model,
  };

  Object.assign(sdkOptions.env, upstreamEnv);

  // 走 --settings 通道：其 env 按键覆盖用户 settings.json，优先级更高。
  // 进程 env 不可靠 —— 会被 settings.json 反向覆盖。
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    env: { ...(sdkOptions.settings?.env || {}), ...upstreamEnv },
  };
}
```

同时保留写入 `sdkOptions.env`：CLI 若再派生进程，它们读到的仍是一致配置。

### 为什么不用 `CLAUDE_CONFIG_DIR` 隔离

该方案会把整个 `~/.claude` 一并搬迁，包括会话历史目录 `~/.claude/projects`——而 CloudCLI 正是按该路径扫描历史会话，会导致历史会话「消失」。此外它会丢弃与端点无关的有用配置（`API_TIMEOUT_MS`、`DISABLE_AUTOUPDATER`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`），而按键合并会自动继承它们。

### 顺序约束

两处顺序是隐蔽的失效点，需以注释固定：

1. 本块必须在 `sdkOptions.model` 赋值**之后**（需用最终模型名钉住别名）。
2. 本块必须在 `applyClaudeEffort` **之前**（它 spread 现有 `settings`，排在后面前面的 `env` 才不会被覆盖）。

## 测试

补充至 `server/modules/providers/tests/`：

| 用例 | 断言 |
|---|---|
| 有上游 | `settings.env` 同时含 BASE_URL / AUTH_TOKEN / ANTHROPIC_MODEL / HAIKU 四键 |
| 无上游 | `settings` 不被触碰（向后兼容；原提交已保证此语义，需回归覆盖） |
| extraEnv 指定 haiku | 采用 extraEnv 的值 |
| 未指定 haiku | 退回 `sdkOptions.model` |
| `sdkOptions.env` | 仍写入同样四键 |

端到端验证（L2，价值最高）：以上游解析结果构造真实 `--settings` 载荷，令 `ANTHROPIC_BASE_URL` 指向 `http://127.0.0.1:9`，断言连接失败。该断言验证的是「配置真的改变了进程去向」，无法被 mock 伪造——本次根因正是靠该手法查出的。

## 残留风险

若宿主 `settings.json` 另设 `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` 等键，因按键合并语义它们会存活。当前宿主机**未设置**这些键，故不受影响；换机部署时可通过上游的 `extraEnv` 字段手动接管。

通用加固（以宿主 `settings.json` 的 env 为基底再覆盖端点键）本次**不做**：它会引入 runtime → auth 模块的耦合，而当前宿主环境无此需求。

## 部署步骤

1. `npm run build`（`build:server` 依赖 `tsc` + `tsc-alias`，源码仓库中已齐备）
2. promote `dist-server` 并安装到全局包 `/usr/lib/node_modules/@cloudcli-ai/cloudcli`
3. **退役 DeepSeek 模型补丁**：启动脚本不再替换模型清单（它会覆盖新功能的模型目录），仅保留 `claude-sdk` 符号链接维护——那是为绕开上游 Linux 平台 bug 所需，不可移除
4. 配置上游：DeepSeek 一套 + GLM 两套（`glm-5.3` / `glm-5.3-flash`），端点 `https://open.bigmodel.cn/api/anthropic`，验证各自可通且额度独立

## 回滚

`dist-server` 由源码重建可得；上游配置存于应用内 SQLite，「无上游配置」即回到与改动前字节一致的行为（原提交的兼容性语义）。回滚不需要回退 npm 包。
