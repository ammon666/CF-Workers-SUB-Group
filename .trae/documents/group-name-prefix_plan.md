# Plan：为分组内节点名称添加分组名前缀

## 一、仓库研究结论

当前项目为 Cloudflare Workers 脚本，仅一个文件 [worker.js](file:///d:/CF-Workers-SUB-Group/worker.js)，功能包括：

1. **存储结构**：`storeData.groups` 为分组数组，每个分组有 `{id, name, nodes}`，`nodes` 是节点链接字符串数组（原始节点文本，与管理面板 textarea 中显示/编辑的内容一致，直接以 `\n` join）。
2. **管理面板**（[renderAdminPanel](file:///d:/CF-Workers-SUB-Group/worker.js#L326-L535)）：
   - 用户在 textarea 中看到并编辑的是 `nodes.join('\n')` 的原始节点文本。
   - 保存时直接把 textarea 每行当做节点写回 `g.nodes`。
3. **订阅输出**（第 144-150 行）：
   ```
   for (const gid of matchedBind.bindGroupIds) {
       const g = groups.find(item => item.id === gid);
       if (g && Array.isArray(g.nodes)) {
           allNodeText += g.nodes.join('\n') + '\n';
       }
   }
   ```
   直接把 `g.nodes` 原样拼出，经过 `ADD()` 切分后作为本地节点。
4. **节点格式**：由用户给出的示例可知，节点包含 `vless://...#节点名`、`vmess://{base64}`、`hysteria2/tuic/anytls` 等多种协议，名称位置各不同：
   - 带 `#` 类型（vless、hysteria2、tuic、anytls、trojan、ss 等）：名称在 URL `#` 后的 fragment 部分。
   - `vmess://`：base64 JSON 里的 `ps` 字段。

用户要求：**保持现有功能、逻辑、界面完全不动**，仅新增"节点名称加上分组名前缀"的行为。

## 二、修改点与新增项

仅需修改 [worker.js](file:///d:/CF-Workers-SUB-Group/worker.js) 一个文件：

1. **新增辅助函数 `prefixNodeName(groupName, nodeLine)`**：
   - 负责对一条节点链接做"节点名前加 `[groupName] - "` 前缀"的处理。
   - 兼容如下协议/格式：
     - 包含 `#` 的链接：`scheme://...#节点名` → 改写 `#` 后的片段为 `[groupName] - 节点名`；如无 `#` 则补 `#[groupName] - groupName`。
     - `vmess://{base64}`：解码 JSON → 写入 `ps` 字段为 `[groupName] - 原ps` → 重新 base64 编码。
     - 其它含 `://` 但以上未命中的行：保持原样不破坏。
   - 对不合法/无法识别的行保持原样，避免破坏已有数据。
2. **仅在"订阅输出时"调用，不改存储、不改面板**：
   - 在第 144-150 行的聚合循环中，把 `g.nodes` 每项先过 `prefixNodeName(g.name, node)` 再 `join`，从而在订阅响应中"看起来"带有前缀。
   - **存储层（KV）不变**，管理面板 textarea 中显示的仍是用户原始节点，保存逻辑不变，从而实现"功能、逻辑、界面不动"。

## 三、具体修改步骤

### 步骤 1：在 [worker.js](file:///d:/CF-Workers-SUB-Group/worker.js) 中新增工具函数

在文件底部（例如 `base64Decode` 之后、`renderAdminPanel` 之前）新增：

```
// 给一条节点链接的"节点名称"加上分组名前缀
// groupNamePrefix 形式: "[分组名] - "
function prefixNodeName(groupName, nodeLine) {
    const line = (nodeLine || "").trim();
    if (!line) return nodeLine || "";
    const prefix = "[" + (groupName || "").trim() + "] - ";

    // 1) vmess:// 需解码修改 ps 字段
    if (line.toLowerCase().startsWith("vmess://")) {
        try {
            const payload = line.slice("vmess://".length);
            let jsonStr;
            try {
                jsonStr = base64Decode(payload);
            } catch (e) {
                return nodeLine; // 无法解码，保持原样
            }
            const obj = JSON.parse(jsonStr);
            const originalPs = typeof obj.ps === "string" && obj.ps.length > 0 ? obj.ps : (groupName || "node");
            obj.ps = prefix + originalPs;
            const newJson = JSON.stringify(obj);
            let newB64;
            try {
                newB64 = btoa(newJson);
            } catch (e) {
                newB64 = encodeBase64(newJson);
            }
            return "vmess://" + newB64;
        } catch (e) {
            return nodeLine;
        }
    }

    // 2) 包含 # 的链接：vless / trojan / ss / hysteria2 / tuic / anytls / ...
    if (line.indexOf("://") !== -1) {
        const hashIdx = line.indexOf("#");
        if (hashIdx !== -1) {
            const head = line.slice(0, hashIdx);
            const rawName = line.slice(hashIdx + 1);
            let decodedName;
            try {
                decodedName = decodeURIComponent(rawName);
            } catch (e) {
                decodedName = rawName;
            }
            // 避免重复添加前缀：如果名称已经以该前缀开头，则不改
            if (decodedName.indexOf(prefix) === 0) {
                return nodeLine;
            }
            const newName = prefix + decodedName;
            return head + "#" + encodeURIComponent(decodedName).replace(/%20/g, " ") === head + "#" + newName
                ? head + "#" + newName
                : head + "#" + newName;
        } else {
            // 没有 # 字段：追加一个以分组名为基础的名称
            return line + "#" + prefix + (groupName || "node");
        }
    }

    // 3) 其它无法识别的行：原样返回
    return nodeLine;
}
```

注意：上面示例中的 `encodeURIComponent` 分支只是思路；真正实现时统一使用简单拼接 `head + "#" + prefix + decodedName` 即可，避免 `replace` 造成的误判。为保证可读性与稳定性，推荐实现版本直接：

```
return head + "#" + prefix + decodedName;
```

并对 `decodedName` 不做二次 encode（常见客户端均能直接显示/处理中文与空格）；也可在 fragment 里做一次轻量 encode，但不影响主流程。

### 步骤 2：修改订阅聚合处调用新函数

第 144-150 行原来为：

```
let allNodeText = "";
for (const gid of matchedBind.bindGroupIds) {
    const g = groups.find(item => item.id === gid);
    if (g && Array.isArray(g.nodes)) {
        allNodeText += g.nodes.join('\n') + '\n';
    }
}
```

改为：

```
let allNodeText = "";
for (const gid of matchedBind.bindGroupIds) {
    const g = groups.find(item => item.id === gid);
    if (g && Array.isArray(g.nodes)) {
        const prefixedNodes = g.nodes.map(n => prefixNodeName(g.name, n));
        allNodeText += prefixedNodes.join('\n') + '\n';
    }
}
```

这样订阅下发时每条节点就会带上 `[分组名] - ` 前缀，而存储与管理面板所见的原始节点不变。

## 四、依赖与外部影响

- 无新增依赖，不引入 npm 包或外部 CDN。
- 复用文件中已有的 `base64Decode` / `encodeBase64` / `btoa`。
- 不修改 KV 存储数据结构，不破坏已有分组/节点/订阅。
- 不修改管理面板 HTML/CSS/JS：用户在 textarea 中看到的仍然是自己粘贴的原始节点。
- 不影响外部订阅（`MainData`/远程订阅获取流程），它们走 `subUrls` 分支与 `getSUB`，不在本方案改动范围内。

## 五、风险与处理

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 节点 fragment 中含特殊字符（中文、空格、`&`、`#`） | 拼接 `prefix` 后可能破坏 URL | 使用 `decodedName` 拼接、保留原文；客户端通常宽松处理 fragment |
| vmess JSON 字段缺失（无 `ps` 字段） | 写入新 `ps` 造成协议兼容问题 | 对缺失字段给默认值 `groupName`，不删除其它字段 |
| vmess base64 包含 padding/换行（某些导出工具产物） | `atob` 失败 | 已做 try/catch，失败时原样返回 |
| 重复前缀（用户多次请求订阅/或手动加过） | 出现 `[A] - [A] - 节点名` | 在函数中判断名称已以 `prefix` 开头时直接返回，避免重复 |
| 节点行不合法（非 `://` 链接） | 被破坏 | 对无法识别的行直接原样返回 |

## 六、改动文件清单

- 仅修改：[worker.js](file:///d:/CF-Workers-SUB-Group/worker.js)
  - 在文件底部（`base64Decode` 之后、`renderAdminPanel` 之前）新增一个函数 `prefixNodeName`。
  - 修改订阅输出分支中聚合 `allNodeText` 的几行代码（约第 148 行），对每个节点调用 `prefixNodeName(g.name, node)`。

## 七、验证方案

1. 在管理面板创建至少 2 个分组，分别命名如 `GroupA`、`GroupB`。
2. 在每个分组内粘贴题目给出的示例节点（vless/vmess/hysteria2/tuic/anytls 各一条），以及若干自定义 `#节点名` 的节点。
3. 勾选上述分组，生成订阅链接，并在浏览器/客户端访问该订阅（带 `?token=...`）。
4. 将订阅 base64 解码：
   - 检查 vless/hysteria2/tuic/anytls 节点 `#` 后节点名变为 `[GroupX] - vl-reality-...`。
   - 把 vmess 节点 base64 再解码，验证 `ps` 字段变为 `[GroupX] - vm-ws-instance-...`。
5. 返回管理面板查看 textarea：内容应仍为原始节点，未被加上前缀。
6. 修改分组名后再次请求订阅，验证节点前缀随之改变。
7. 对已带前缀的节点再次请求订阅（同一次会话或跨请求），不应出现双重前缀。
