<p align="right">
  <strong>PUBLIC LAUNCH NOTE · 2026-08-30</strong>
</p>

<p align="center">
  <img src="./assets/readme/oracle-hero.svg" alt="Oracle 视觉标识：靛蓝与金色字标，下方呈现 sealed context、exact-session recovery、declared batches 与 dedicated Chrome 四项能力" width="1100">
</p>

<p align="center">
  <a href="#简体中文"><strong>简体中文</strong></a> · <a href="#english"><strong>English</strong></a>
</p>

---

<a id="简体中文"></a>

# Oracle：让每一次 Pro 咨询，都有一条回来的路

> Public source launch · 可恢复的 GPT-5.6 Pro consultation，单会话或声明式并行批次。

> **非官方 / unsupported automation boundary：** 这是一条独立维护的 source line，不隶属于 OpenAI，也未获 OpenAI 认可、背书或授权。本仓库不声称 platform-terms compliance；ChatGPT UI、账户策略和适用条款可能变化，使用者须自行判断账户与合规风险。

一次漫长、昂贵、依赖大量上下文的 Pro consultation，不应该活得像一项随时会蒸发的网页操作。真正重要的问题不是浏览器能不能按下 Send，而是：当 tab 断开、前台进程结束，或者回答暂时还没回来，系统是否仍然知道自己提交了什么、哪一条 conversation 拥有这次运行，以及该从哪里继续。

Oracle 给出的答案是一份 recovery contract。每次咨询都有 durable session、提交收据、conversation identity、回答与实际产生的 artifact 记录，也有可继续的 follow-up lineage。只要一个 turn 已经 commit，恢复就回到原 conversation；它不会把“暂时拿不到回答”擅自改写成“再发一遍”。

## 四个公开承诺

Oracle 把四个彼此相连的产品承诺放进同一条可检查的生命周期。

**Sealed context.** Oracle 只组装明确选定的 prompt 与文件，并把 dispatch evidence 留在 durable session 中。

**Exact session.** 每次运行都绑定到 exact conversation；恢复、answer capture 与 follow-up 沿原 lineage 继续。

**Declared batches.** 第一阶段输入先整体密封，再按不同职责运行 blind lanes；只有 durable barrier 关闭后，optional synthesis 才可能开始。

**Dedicated Chrome.** Canonical lane 使用独立 Chrome for Testing app identity、Oracle-only profile、loopback CDP 与 exact target ownership。

`GPT-5.6 Pro` 是当前的人类可读目标；CLI 使用稳定别名 `gpt-5-pro`。Dedicated Chrome 是 canonical lane。OpenCLI 保留为普通 text consultation 的显式 alternative transport，不会在 CDP 失败后静默接管，也不承载 Batch Oracle。

## 两条路径，共享一份 session truth

### 单会话：一条 conversation，一条可继续的 lineage

Oracle 在本地组装选定 context，建立 session，再通过 loopback CDP 在 Dedicated Chrome 中创建并拥有一个 exact target。提交后，conversation identity、timing evidence、answer、artifacts 与 follow-up lineage 回到同一个 session 中。

如果长时间运行被打断，`oracle session <session-id>` 与显式 follow-up 都从这份 durable state 出发。恢复的核心不是“再试一次”，而是先判断先前 turn 是否已经 commit：有 receipt 就回到原 conversation；只有 durable evidence 明确证明 prompt 未提交、未 commit 且 `retrySafe:true` 时，显式 resume 才能创建新 attempt。

### Batch Oracle：先密封，再并行；先过 barrier，再综合

Batch Oracle 用于同一决策里至少两项可以独立审查的问题。每条 lane 有自己的 mandate、falsification target、evidence、prompt、output contract 和 recoverable child session。所有第一阶段输入先从同一 admitted-source snapshot 组装并密封，然后才开始 dispatch；stage 仍然开放时，sibling answers 保持隔离。

当所有 lane 都产生 verified answer，或对确实不可恢复的缺失留下显式 owner decision，durable barrier 才会关闭。Optional synthesis 只在此后启动，必须保留 provenance 与 dissent。Batch Oracle 不是同题投票、滚动共识，也不会用一个新 prompt 替换已经 commit 的 child conversation。

## 浏览器边界就是产品边界

Canonical browser lane 同时使用两层隔离：

- Chrome for Testing 提供与日常 Chrome 不同的 app identity；
- Oracle-only persistent profile 将 ChatGPT 登录状态与个人浏览、其他账户和 extensions 分开。

普通运行只在 `127.0.0.1` 上开放 CDP，并以 exact target ID 管理自己创建的页面。首次登录、真实 authentication challenge 与模型 entitlement 仍由人完成；Oracle 不绕过 account controls，也不把专用 profile 伪装成无风险的 credential store。

在 macOS 上，显式启用 `--use-mock-keychain` 可以避免独立 profile 反复请求日常 Chrome Safe Storage，同时会降低该 profile 的静态 cookie 保护强度。这个 tradeoff 只适合 owner-only、ChatGPT-only 的专用 profile。

## 从源码开始

当前公开的是 IndelibleVivi fork 的 source line，不是新的 npm、Homebrew 或 tagged package release。上游渠道发布的 Oracle package 不包含这里的 fork-specific contract；请直接从本仓库安装。

要求：Node.js 24 或更新版本，以及能够访问目标 model 与 reasoning tier 的 ChatGPT account。

```bash
git clone https://github.com/IndelibleVivi/oracle.git
cd oracle
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm link
```

建立专用 browser identity，并先运行不会提交 prompt 的两次冷启动验证：

```bash
oracle browser install
oracle browser setup --use-mock-keychain
oracle browser smoke
```

然后运行一项普通咨询：

```bash
oracle --engine browser \
  --model gpt-5-pro \
  -p "Audit this change for correctness and missing tests." \
  --file "src/**"
```

## 当前边界

- Oracle 持久化和恢复它所拥有的 session；它不保证 ChatGPT service、账户 entitlement 或网络永远可用。
- 一个 committed turn 不会被 silent resubmit。Ambiguous state 会停下来要求检查，而不是赌一次 duplicate send。
- OpenCLI 是显式 alternative，不是 automatic fallback；Batch Oracle v1 只走 canonical Dedicated CDP Pro lane。
- Missing lane、partial synthesis 与不可恢复的 committed synthesis 都需要 durable owner closure；Oracle 不静默接受缺失。
- 这是一条公开 source line，不是 upstream release，不附属于、代表、获 OpenAI 背书或授权，也不声称 platform-terms compliance。

Oracle 由 [steipete/oracle](https://github.com/steipete/oracle) fork 而来，保留 upstream Git history 与 MIT license。Dedicated Chrome 默认路径、fork 的 Pro receipt / timing contract、OpenCLI alternative 与 Batch Oracle 由这条 source line 维护；本说明只代表这里公开并可验证的当前边界。

## 继续阅读

- [中文 README](./README.md) · [English README](./README.en.md)
- [Dedicated Chrome transport](./docs/dedicated-chrome.md)
- [Batch Oracle v1](./docs/batch-oracle.md)
- [Sessions and recovery](./docs/sessions.md)
- [OpenCLI alternative transport](./docs/opencli-transport.md)

Oracle 不能缩短一次严肃 Pro 运行真正需要的思考时间。它做的是另一件更重要的事：让等待留下收据，让 conversation 有身份，也让人知道该从哪里回来。

---

<a id="english"></a>

# Oracle: give every Pro consultation a way back

> Public source launch · Recoverable GPT-5.6 Pro consultations, as one session or a declared parallel batch.

> **Unofficial / unsupported automation boundary:** This independently maintained source line is not affiliated with, endorsed by, or authorized by OpenAI. It makes no platform-terms-compliance claim. ChatGPT UI, account policies, and applicable terms may change; operators are responsible for evaluating account and compliance risk.

A long, expensive, context-heavy Pro consultation should not live like a disposable browser action. The important question is not whether automation can press Send. It is whether, after a tab disconnects, the foreground process exits, or the answer has not arrived yet, the system still knows what it committed, which conversation owns the run, and where to continue.

Oracle answers with a recovery contract. A consultation receives a durable session, dispatch receipts, conversation identity, captured answers and any produced artifacts, and a follow-up lineage. Once a turn is committed, recovery returns to that conversation. “The answer is not available yet” never silently becomes “send the prompt again.”

## Four public promises

Oracle joins four product promises into one inspectable lifecycle.

**Sealed context.** Oracle assembles only the selected prompt and files, then retains durable dispatch evidence inside the session.

**Exact session.** Every run is bound to one exact conversation; recovery, answer capture, and follow-up continue along its lineage.

**Declared batches.** The complete first-stage input is sealed before blind lanes run under distinct responsibilities. Optional synthesis can start only after the durable barrier closes.

**Dedicated Chrome.** The canonical lane uses a separate Chrome for Testing app identity, an Oracle-only profile, loopback CDP, and exact target ownership.

`GPT-5.6 Pro` is the current human-facing target; the CLI uses the stable alias `gpt-5-pro`. Dedicated Chrome is the canonical lane. OpenCLI remains an explicit alternative transport for ordinary text consultations. It never takes over a failed CDP run silently, and it does not carry Batch Oracle.

## Two paths, one session truth

### Single consultation: one conversation, one continuing lineage

Oracle assembles the selected context locally, creates a session, and uses loopback CDP to create and own one exact target inside Dedicated Chrome. After submission, conversation identity, timing evidence, the answer, artifacts, and follow-up lineage return to that same session.

If a long run is interrupted, `oracle session <session-id>` and explicit follow-ups begin from that durable state. Recovery is not a generic retry. Oracle first determines whether the earlier turn was committed: a durable receipt sends it back to the original conversation; a new attempt is possible only on explicit resume after durable evidence proves that the prompt was unsubmitted, uncommitted, and `retrySafe:true`.

### Batch Oracle: seal first, run in parallel; cross the barrier before synthesis

Batch Oracle is for one decision containing at least two independently reviewable questions. Every lane has its own mandate, falsification target, evidence, prompt, output contract, and recoverable child session. All first-stage inputs are assembled and sealed from one admitted-source snapshot before dispatch begins, and sibling answers remain hidden while the stage is open.

The durable barrier closes only after every lane has a verified answer or an explicit owner decision records genuinely unavailable work. Optional synthesis may start afterward and must preserve provenance and dissent. Batch Oracle is not identical-prompt voting, rolling consensus, or permission to replace a committed child conversation with a new prompt.

## The browser boundary is a product boundary

The canonical browser lane combines two forms of isolation:

- Chrome for Testing supplies an app identity separate from everyday Chrome.
- An Oracle-only persistent profile separates the ChatGPT login from personal browsing, other accounts, and extensions.

Ordinary runs expose CDP only on `127.0.0.1` and manage created pages by exact target ID. A person still completes the first sign-in, real authentication challenges, and model-entitlement gates. Oracle does not bypass account controls, and it does not present the dedicated profile as a risk-free credential store.

On macOS, explicitly choosing `--use-mock-keychain` prevents the isolated profile from repeatedly requesting everyday Chrome Safe Storage access, while weakening at-rest cookie protection for that profile. That tradeoff belongs only in an owner-only, ChatGPT-only dedicated profile.

## Start from source

This launch introduces the IndelibleVivi fork's public source line. It is not a new npm, Homebrew, or tagged package release. Oracle packages published through upstream channels do not contain this fork-specific contract; install this repository directly.

Requirements: Node.js 24 or newer and a ChatGPT account with access to the requested model and reasoning tier.

```bash
git clone https://github.com/IndelibleVivi/oracle.git
cd oracle
corepack enable
pnpm install --frozen-lockfile
pnpm build
npm link
```

Create the dedicated browser identity, then run the two-cold-start validation that submits no prompt:

```bash
oracle browser install
oracle browser setup --use-mock-keychain
oracle browser smoke
```

Run one ordinary consultation:

```bash
oracle --engine browser \
  --model gpt-5-pro \
  -p "Audit this change for correctness and missing tests." \
  --file "src/**"
```

## Current boundaries

- Oracle persists and recovers the sessions it owns; it does not promise permanent ChatGPT service, account entitlement, or network availability.
- A committed turn is never silently resubmitted. Ambiguous state stops for inspection instead of gambling on a duplicate send.
- OpenCLI is an explicit alternative, not an automatic fallback; Batch Oracle v1 uses only the canonical Dedicated CDP Pro lane.
- Missing lanes, partial synthesis, and a committed synthesis that remains unavailable all require durable owner closure. Oracle never accepts missing work silently.
- This is a public source line, not an upstream release. It is not affiliated with, endorsed by, or authorized by OpenAI and makes no platform-terms-compliance claim.

Oracle is forked from [steipete/oracle](https://github.com/steipete/oracle), preserving its Git history and MIT license. The Dedicated Chrome default, the fork's Pro receipt and timing contract, the OpenCLI alternative, and Batch Oracle are maintained in this source line. This note speaks only for the current boundary that is public and verifiable here.

## Read next

- [Chinese README](./README.md) · [English README](./README.en.md)
- [Dedicated Chrome transport](./docs/dedicated-chrome.md)
- [Batch Oracle v1](./docs/batch-oracle.md)
- [Sessions and recovery](./docs/sessions.md)
- [OpenCLI alternative transport](./docs/opencli-transport.md)

Oracle does not pretend to shorten the time a serious Pro run needs. It does something more useful: gives the wait a receipt, the conversation an identity, and the operator a way back.
