# 第三方来源与许可（Third-party attributions）

本目录（`docs/absorbed/`）里的文件**不是本项目的原创内容**，而是为了研究
AI 短剧的成熟做法而**逐字收录**的第三方资料。它们只作为参考资料保留，
**不参与运行时**——`lib/` 下的任何代码都不 import 这个目录。

按上游许可证的要求，版权与许可原文一并保留：

| 目录/文件 | 上游项目 | 许可证 | 说明 |
|---|---|---|---|
| `anchor__*.md`、`EP001__*.jsonl/md`、`UPSTREAM-README.md` | [zenstory-ai/drama-skills](https://github.com/zenstory-ai/drama-skills) | **MIT** | 短剧创作工作流技能：人物锚点库（invariants / allowed-variations / wardrobe-logic）、分集剧本与分镜 JSONL、图片与运动提示词规格 |
| `LICENSE-upstream.txt` | 同上 | MIT | 上游许可证原文，含版权行 `Copyright (c) 2026 drama-skills contributors` |

上游 MIT 许可证允许再分发，条件是**保留版权声明和许可文本**——这正是
`LICENSE-upstream.txt` 存在的原因。请勿删除它。

## 本项目自己的代码

`lib/` 是本项目原创实现，同样以 MIT 发布（见仓库根目录的 `LICENSE`）。

## 如果你要再分发

1. 保留 `LICENSE-upstream.txt`；
2. 保留本文件的来源表；
3. 如果你修改了 `docs/absorbed/` 下的任何文件，请明确标注改动，
   MIT 不授予你用上游作者名义背书的权利。

## 吸收了但**没有**收录原文的部分

研究和实现过程中参考过、但**未逐字收录**的项目包括 MiniMax / Seedance 的公开协议说明、
以及若干提示词工程文章。这类参考只影响 `lib/host/prompts.js` 的设计取舍，
不构成对原文的再分发。

