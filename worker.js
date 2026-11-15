// ==================== CF-Workers-SUB-Group 多分组订阅方案（支持订阅链接二次编辑：改名 / 改分组） ====================


let adminSecret = 'fallback-admin';
let FileName = 'CF-Workers-SUB-Group';
let SUBUpdateTime = 6;

// 外部订阅导入配置
let MainData = "";
let subConverter = "SUBAPI.cmliussss.net";
let subConfig = "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini";
let subProtocol = 'https';

// 系统常量
const KV_STORE_KEY = "SUB_GROUP_DATA";
const FETCH_TIMEOUT = 2000;

export default {
	async fetch(request, env) {
		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
		const urlObj = new URL(request.url);

		// 读取独立管理密钥环境变量
		// 注意：Cloudflare 面板里粘贴时经常带上空格/换行，必须 trim，否则后台路径永远匹配不上
		const rawAdminToken = (env.ADMIN_TOKEN === undefined || env.ADMIN_TOKEN === null) ? "" : String(env.ADMIN_TOKEN);
		adminSecret = rawAdminToken.trim() || 'fallback-admin';
		subConverter = env.SUBAPI || subConverter;
		SUBUpdateTime = Number(env.SUBUPTIME ?? SUBUpdateTime);
		subConfig = env.SUBNAME || subConfig;
		FileName = env.SUBNAME || FileName;

		// 处理外部订阅协议前缀
		if (subConverter.indexOf("http://") === 0) {
			subConverter = subConverter.replace("http://", "");
			subProtocol = 'http';
		} else {
			subConverter = subConverter.replace("https://", "");
		}

		// 读取KV完整存储数据
		const kvRaw = await env.KV.get(KV_STORE_KEY);
		let storeData;
		if (!kvRaw) {
			storeData = {
				groups: [],
				subBindList: []
			};
			await env.KV.put(KV_STORE_KEY, JSON.stringify(storeData));
		} else {
			storeData = JSON.parse(kvRaw);
			if (!Array.isArray(storeData.groups)) storeData.groups = [];
			if (!Array.isArray(storeData.subBindList)) storeData.subBindList = [];
			// 兼容旧订阅补充name字段 / 补齐 bindGroupIds 数组
			for (const item of storeData.subBindList) {
				if (typeof item.name === "undefined") item.name = "";
				if (!Array.isArray(item.bindGroupIds)) item.bindGroupIds = [];
			}
		}
		const { groups, subBindList } = storeData;

		// 管理面板路径判定（同时兼容结尾带 / 的写法）
		const adminPath = "/" + adminSecret;
		const isAdminRoute = urlObj.pathname === adminPath ||
			urlObj.pathname === adminPath + "/" ||
			urlObj.pathname === adminPath.replace(/\/+$/, "");

		// =========== 诊断分支：?diag=1 自查（不返回密钥本身） ===========
		if (request.method === "GET" && urlObj.searchParams.has("diag") && !urlObj.searchParams.has("token")) {
			const diagInfo = {
				host: urlObj.host,
				adminTokenFromEnv: rawAdminToken.trim().length > 0,
				adminTokenLength: adminSecret.length,
				adminTokenHadWhitespace: rawAdminToken.length > 0 && rawAdminToken !== rawAdminToken.trim(),
				adminPathHit: isAdminRoute,
				kvReady: true,
				groups: groups.length,
				subscriptions: subBindList.length
			};
			return new Response(JSON.stringify(diagInfo, null, 2), {
				headers: { "Content-Type": "application/json;charset=utf-8" }
			});
		}

		// =========== 分支1：管理面板路由 ===========
		if (isAdminRoute) {
			// POST 请求：处理分组/订阅绑定增删改
			if (request.method === "POST") {
				try {
					const postBody = await request.text();
					const reqData = JSON.parse(postBody);
					// 只保留仍然存在的分组ID，避免脏数据
					const sanitizeGids = (gidList) => {
						if (!Array.isArray(gidList)) return [];
						return gidList.filter(gid => storeData.groups.some(g => g.id === gid));
					};
					switch (reqData.action) {
						// 分组操作
						case "addGroup":
							storeData.groups.unshift({
								id: "group_" + Date.now(),
								name: (reqData.name || "新分组").trim(),
								nodes: []
							});
							break;
						case "updateGroupName": {
							const g = storeData.groups.find(item => item.id === reqData.gid);
							if (g) g.name = (reqData.name || "").trim();
							break;
						}
						case "updateGroupNodes": {
							const g = storeData.groups.find(item => item.id === reqData.gid);
							if (g) g.nodes = Array.isArray(reqData.nodes) ? reqData.nodes : [];
							break;
						}
						case "delGroup":
							storeData.groups = storeData.groups.filter(item => item.id !== reqData.gid);
							// 删除分组同步清理绑定该分组的订阅
							storeData.subBindList = storeData.subBindList.filter(bind => !(bind.bindGroupIds || []).includes(reqData.gid));
							break;
						// 订阅绑定操作：新建订阅插入数组头部，实现置顶
						case "createSubBind": {
							const bindGids = sanitizeGids(reqData.bindGids);
							if (bindGids.length === 0) {
								return new Response(JSON.stringify({ code: -2, msg: "at least one group required" }), {
									headers: { "Content-Type": "application/json;charset=utf-8" }
								});
							}
							const newSubTok = generateRandomToken(24);
							storeData.subBindList.unshift({
								token: newSubTok,
								bindGroupIds: bindGids,
								name: (reqData.subName || "").trim()
							});
							break;
						}
						// 【新增】编辑已生成的订阅：改名称 + 改勾选分组（token/链接保持不变）
						case "updateSubBind": {
							const bind = storeData.subBindList.find(item => item.token === reqData.token);
							if (!bind) {
								return new Response(JSON.stringify({ code: -1, msg: "subscription not found" }), {
									headers: { "Content-Type": "application/json;charset=utf-8" }
								});
							}
							const bindGids = sanitizeGids(reqData.bindGids);
							// 至少保留一个有效分组，避免订阅变成空链接
							if (bindGids.length === 0) {
								return new Response(JSON.stringify({ code: -2, msg: "at least one group required" }), {
									headers: { "Content-Type": "application/json;charset=utf-8" }
								});
							}
							bind.name = (reqData.subName || "").trim();
							bind.bindGroupIds = bindGids;
							break;
						}
						case "delSubBind":
							storeData.subBindList = storeData.subBindList.filter(bind => bind.token !== reqData.token);
							break;
					}
					// 写入KV持久化
					await env.KV.put(KV_STORE_KEY, JSON.stringify(storeData));
					return new Response(JSON.stringify({ code: 0 }), {
						headers: { "Content-Type": "application/json;charset=utf-8" }
					});
				} catch (err) {
					return new Response(JSON.stringify({ code: -1 }), {
						headers: { "Content-Type": "application/json;charset=utf-8" }
					});
				}
			}

			// 浏览器GET访问管理页面
			if (userAgent.indexOf('mozilla') !== -1 && urlObj.search === "") {
				return await renderAdminPanel(request, env, groups, subBindList, urlObj);
			}

			// 非法访问管理路径拦截
			if (env.URL302) return Response.redirect(env.URL302, 302);
			if (env.URL) return await proxyURL(env.URL, urlObj);
			return new Response(await nginxDenied(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
		}

		// =========== 分支2：订阅请求鉴权（匹配绑定分组） ===========
		const subTokenParam = urlObj.searchParams.get('token');
		let matchedBind = null;
		if (subTokenParam) {
			matchedBind = subBindList.find(bind => bind.token === subTokenParam);
		}
		// 无匹配订阅绑定=权限不足
		if (!matchedBind) {
			if (env.URL302) return Response.redirect(env.URL302, 302);
			if (env.URL) return await proxyURL(env.URL, urlObj);
			// 浏览器直接访问（没有带 token）：给一个中性的提示页，方便站长自查路径，不泄露密钥
			if (userAgent.indexOf('mozilla') !== -1 && !subTokenParam) {
				return new Response(noAccessHtml(urlObj, rawAdminToken), {
					status: 403,
					headers: { 'Content-Type': 'text/html; charset=UTF-8' }
				});
			}
			return new Response("Access Denied: Valid subscription token required", { status: 403 });
		}

		// 聚合绑定分组内所有节点生成订阅（输出时给节点名加分组前缀，存储不变）
		// 注意：这里每次都按 token 对应的 bindGroupIds 实时生成，所以编辑分组勾选后链接内容立即生效
		let allNodeText = "";
		for (const gid of matchedBind.bindGroupIds) {
			const g = groups.find(item => item.id === gid);
			if (g && Array.isArray(g.nodes)) {
				const prefixedNodes = g.nodes.map(n => prefixNodeName(g.name, n));
				allNodeText += prefixedNodes.join('\n') + '\n';
			}
		}

		// 合并外部订阅
		const mainList = await ADD(MainData);
		const groupList = await ADD(allNodeText);
		const mergeList = [...mainList, ...groupList].filter(v => v && v.trim());

		let subUrls = [];
		let localNodes = [];
		for (const item of mergeList) {
			const trimItem = item.trim();
			if (trimItem.toLowerCase().startsWith('http')) {
				subUrls.push(trimItem);
			} else {
				localNodes.push(trimItem);
			}
		}

		let remoteContent = "";
		if (subUrls.length > 0) {
			const subResult = await getSUB(subUrls, request, "v2rayn", userAgentHeader);
			remoteContent = subResult[0].join('\n');
		}

		const finalRaw = localNodes.join('\n') + '\n' + remoteContent;
		const uniqueSet = [...new Set(finalRaw.split('\n'))].join('\n');

		let base64Data;
		try {
			base64Data = btoa(uniqueSet);
		} catch (e) {
			base64Data = encodeBase64(uniqueSet);
		}

		// 移除 Subscription-Userinfo 流量过期相关头与计算变量
		const headers = {
			"content-type": "text/plain; charset=utf-8",
			"Profile-Update-Interval": String(SUBUpdateTime),
			"Profile-web-page-url": urlObj.origin
		};
		return new Response(base64Data, { headers });
	}
};

// 生成随机订阅Token
function generateRandomToken(len = 24) {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let res = "";
	for (let i = 0; i < len; i++) {
		res += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return res;
}

// HTML转义，避免分组名/订阅名中的特殊字符破坏页面结构
function escapeHtml(str) {
	return String(str === null || str === undefined ? "" : str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

async function ADD(envadd) {
	let addtext = envadd.replace(/[	"'|\r\n]+/g, '\n').replace(/\n+/g, '\n');
	if (addtext.charAt(0) === '\n') addtext = addtext.slice(1);
	if (addtext.length > 0 && addtext.charAt(addtext.length - 1) === '\n') addtext = addtext.slice(0, -1);
	return addtext.split('\n');
}

function nginxDenied() {
	return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Access Denied</title></head><body><h1>403 Access Denied</h1><p>Invalid admin access</p></body></html>';
}

// 无有效 token 的浏览器访问提示页（不显示密钥本身，只提示怎么自查）
function noAccessHtml(urlObj, rawAdminToken) {
	const tokenState = rawAdminToken.trim().length === 0
		? "未配置 ADMIN_TOKEN，后台路径为 /fallback-admin"
		: "已配置 ADMIN_TOKEN（长度 " + rawAdminToken.trim().length + "），后台路径为 /<你的 ADMIN_TOKEN>" +
			(rawAdminToken !== rawAdminToken.trim() ? "；检测到该值带有空格/换行，已在本次运行中自动忽略" : "");
	const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
		'<title>403 路径未匹配</title><style>' +
		'body{font-family:"Microsoft Yahei",Arial,sans-serif;background:#fff;color:#333;padding:28px;line-height:1.8;}' +
		'.box{max-width:720px;margin:0 auto;border:1px solid #ddd;padding:22px;background:#fafafa;}' +
		'h1{font-size:20px;margin-bottom:12px;}code{background:#eee;padding:2px 6px;font-family:monospace;}' +
		'.grey{color:#777;font-size:14px;}' +
		'ul{margin:10px 0 0 20px;}li{margin:6px 0;}' +
		'</style></head><body><div class="box">' +
		'<h1>403 路径未匹配</h1>' +
		'<p>这个地址既不是有效的订阅链接，也不是管理面板入口。</p>' +
		'<p class="grey">订阅链接需要带 <code>?token=xxxx</code>；管理面板需要访问 <code>/&lt;ADMIN_TOKEN&gt;</code>。</p>' +
		'<p class="grey">当前域名：<code>' + escapeHtml(urlObj.host) + '</code></p>' +
		'<p class="grey">' + escapeHtml(tokenState) + '</p>' +
		'<p class="grey">自查：访问 <code>/?diag=1</code> 可看到管理密钥长度、是否带空白字符、分组与订阅数量。</p>' +
		'<p class="grey">如果你刚改过域名：确认 Workers 的「自定义域名 / 路由」已经包含这个域名，并且改完环境变量后重新 Deploy 过。</p>' +
		'</div></body></html>';
	return html;
}

async function MD5MD5(text) {
	const encoder = new TextEncoder();
	const firstBuf = await crypto.subtle.digest('MD5', encoder.encode(text));
	const firstHex = Array.from(new Uint8Array(firstBuf)).map(b => b.toString(16).padStart(2)).join('');
	const sliceStr = firstHex.length >= 27 ? firstHex.slice(7, 27) : firstHex;
	const secondBuf = await crypto.subtle.digest('MD5', encoder.encode(sliceStr));
	return Array.from(new Uint8Array(secondBuf)).map(b => b.toString(16).padStart(2)).join('').toLowerCase();
}

async function proxyURL(proxyURL, urlObj) {
	try {
		const URLs = await ADD(proxyURL);
		const fullURL = URLs[Math.floor(Math.random() * URLs.length)];
		const parsedURL = new URL(fullURL);
		let newPath = parsedURL.pathname;
		if (newPath.endsWith('/')) newPath = newPath.slice(0, -1);
		newPath += urlObj.pathname + urlObj.search;
		const targetUrl = parsedURL.protocol + "//" + parsedURL.host + newPath;
		const res = await fetch(targetUrl);
		return new Response(res.body, { status: res.status, headers: res.headers });
	} catch (e) {
		return new Response("Proxy Error", { status: 502 });
	}
}

async function getSUB(urlList, request, uaText, userAgentHeader) {
	if (!Array.isArray(urlList) || urlList.length === 0) {
		return [[], ""];
	}
	const validList = urlList.filter(item => item && item.trim());
	let newapi = "";
	let subUrlsStr = "";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

	try {
		const tasks = [];
		for (let i = 0; i < validList.length; i++) {
			tasks.push(getUrlItem(validList[i], request, uaText, userAgentHeader, controller.signal));
		}
		const results = await Promise.allSettled(tasks);
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r.status !== 'fulfilled') continue;
			const txt = r.value;
			if (txt.includes('proxies') || txt.includes('"outbounds"')) {
				subUrlsStr += "|" + validList[i];
			} else if (txt.includes('://')) {
				newapi += txt + "\n";
			} else if (isValidBase64(txt)) {
				newapi += base64Decode(txt) + "\n";
			}
		}
	} catch (e) {} finally {
		clearTimeout(timer);
	}

	const list = await ADD(newapi);
	return [list, subUrlsStr];
}

async function getUrlItem(targetUrl, request, uaText, userAgentHeader, signal) {
	const newHeaders = new Headers(request.headers);
	newHeaders.set("User-Agent", "v2rayN/6.45 cmliu/CF-Workers-SUB " + uaText + "(" + userAgentHeader + ")");
	const req = new Request(targetUrl, {
		method: request.method,
		headers: newHeaders,
		body: request.method === "GET" ? null : request.body,
		redirect: "follow",
		signal: signal,
		cf: { insecureSkipVerify: true, allowUntrusted: true, validateCertificate: false }
	});
	const res = await fetch(req);
	if (!res.ok) throw new Error("Request fail");
	return await res.text();
}

function isValidBase64(str) {
	const clean = str.replace(/\s/g, '');
	return /^[A-Za-z0-9+/=]+$/.test(clean);
}

function encodeBase64(data) {
	const binData = new TextEncoder().encode(data);
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let result = "";
	let i = 0;
	const totalLen = binData.length;
	while (i < totalLen) {
		const a = binData[i++];
		const b = i < totalLen ? binData[i++] : 0;
		const c = i < totalLen ? binData[i++] : 0;
		result += chars[(a >> 2) & 0x3F];
		result += chars[((a & 3) << 4) | ((b >> 4) & 0x0F)];
		result += chars[((b & 0x0F) << 2) | ((c >> 6) & 0x03)];
		result += chars[c & 0x3F];
	}
	const padCount = (3 - (totalLen % 3)) % 3;
	if (padCount > 0) {
		result = result.substring(0, result.length - padCount);
		result += "==".substring(0, padCount);
	}
	return result;
}

function base64Decode(str) {
	const bytes = new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
	return new TextDecoder('utf-8').decode(bytes);
}

// 给一条节点链接的"节点名称"加上分组名前缀，格式 "[分组名]-原名"（仅改前缀，保留原名中所有空格）
// 仅影响输出，不改存储
function prefixNodeName(groupName, nodeLine) {
	const line = (nodeLine || "").trim();
	if (!line) return nodeLine || "";
	const trimmedGroup = (groupName || "").trim();
	const prefix = "[" + trimmedGroup + "]-";

	// 1) vmess:// base64 JSON：修改 ps 字段
	if (line.toLowerCase().startsWith("vmess://")) {
		try {
			const payload = line.slice("vmess://".length);
			let jsonStr;
			try {
				jsonStr = base64Decode(payload);
			} catch (e) {
				return nodeLine;
			}
			const obj = JSON.parse(jsonStr);
			const originalPs = (typeof obj.ps === "string" && obj.ps.length > 0) ? obj.ps : (trimmedGroup || "node");
			if (originalPs.indexOf(prefix) === 0) {
				return nodeLine;
			}
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

	// 2) 其它含 :// 的链接：名称在 # 之后的 fragment 中
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
			if (decodedName.indexOf(prefix) === 0) {
				return nodeLine;
			}
			return head + "#" + prefix + decodedName;
		} else {
			// 没有 # 字段：补一个带前缀的名称
			return line + "#" + prefix + (trimmedGroup || "node");
		}
	}

	// 3) 其它无法识别的行：原样返回
	return nodeLine;
}

// 管理面板页面渲染：订阅紧凑布局、点击复制、删除/编辑按钮同行右侧、已创建订阅可二次编辑
async function renderAdminPanel(request, env, groups, subBindList, urlObj) {
	const origin = urlObj.origin;

	// 分组多选HTML
	let groupCheckHtml = "";
	if (groups.length === 0) {
		groupCheckHtml = '<div class="empty-tip">暂无分组，请先新增分组</div>';
	} else {
		for (const g of groups) {
			groupCheckHtml += `<label class="check-item">
				<input type="checkbox" class="group-check" value="${g.id}" data-gname="${escapeHtml(g.name)}">
				<span>${escapeHtml(g.name)}</span>
			</label>`;
		}
	}

	// 现有订阅列表，紧凑布局，隐藏单独token，链接+编辑/删除按钮同行，点击输入框复制
	let subListHtml = "";
	if (subBindList.length === 0) {
		subListHtml = '<p class="empty-tip">暂无生成的订阅，勾选分组后创建</p>';
	} else {
		for (const bind of subBindList) {
			const subUrl = `${origin}?token=${bind.token}`;
			const bindGids = Array.isArray(bind.bindGroupIds) ? bind.bindGroupIds : [];
			// 获取绑定分组名称
			const bindNames = bindGids.map(gid => {
				const g = groups.find(x => x.id === gid);
				return g ? g.name : "[已删除分组]";
			}).join("、");
			// 展示名称：自定义名称优先
			const displayName = bind.name || `订阅-${bindNames || "未绑定分组"}`;

			// 订阅编辑区：分组按当前绑定顺序排列，未勾选的排在后面；支持 ↑↓ 调整输出顺序
			let editCheckHtml = "";
			if (groups.length === 0) {
				editCheckHtml = '<div class="empty-tip">暂无分组</div>';
			} else {
				const orderedGroups = [];
				for (const gid of bindGids) {
					const g = groups.find(x => x.id === gid);
					if (g && orderedGroups.indexOf(g) === -1) orderedGroups.push(g);
				}
				for (const g of groups) {
					if (orderedGroups.indexOf(g) === -1) orderedGroups.push(g);
				}
				for (const g of orderedGroups) {
					const checked = bindGids.indexOf(g.id) !== -1;
					editCheckHtml += `<div class="order-row${checked ? "" : " dim"}" data-gid="${g.id}">
						<span class="order-badge"></span>
						<input type="checkbox" class="edit-group-check" value="${g.id}"${checked ? " checked" : ""}>
						<span class="order-name">${escapeHtml(g.name)}</span>
						<span class="order-ctrl">
							<button type="button" class="btn small" onclick="moveGroup('${bind.token}','${g.id}',-1)">↑</button>
							<button type="button" class="btn small" onclick="moveGroup('${bind.token}','${g.id}',1)">↓</button>
						</span>
					</div>`;
				}
			}

			subListHtml += `<div class="sub-item" data-token="${bind.token}">
				<div class="sub-header-line">
					<span class="sub-name">${escapeHtml(displayName)}</span>
					<span class="sub-groups-small">(${escapeHtml(bindNames)})</span>
				</div>
				<div class="sub-url-row">
					<input class="sub-copy-input" readonly onclick="copySub(this)" value="${subUrl}">
					<button class="btn edit-sub" data-token="${bind.token}">编辑</button>
					<button class="btn danger del-sub" data-token="${bind.token}">删除</button>
				</div>
				<div class="sub-editor" id="editor-${bind.token}">
					<div class="field-label">订阅名称</div>
					<input type="text" class="edit-sub-name" placeholder="留空则自动用分组名拼接" value="${escapeHtml(bind.name || "")}">
					<div class="field-label field-label-row">
						<span>包含分组（↑ ↓ 调整订阅内节点顺序）</span>
						<span class="check-actions">
							<button type="button" class="btn small" onclick="toggleAllGroups('${bind.token}',true)">全选</button>
							<button type="button" class="btn small" onclick="toggleAllGroups('${bind.token}',false)">清空</button>
						</span>
					</div>
					<div class="order-list">${editCheckHtml}</div>
					<div class="editor-actions">
						<button class="btn save-green" onclick="saveSubBind('${bind.token}')">保存修改</button>
						<button class="btn" onclick="cancelSubBind('${bind.token}')">取消</button>
					</div>
				</div>
			</div>`;
		}
	}

	// 分组编辑区域HTML
	let groupEditHtml = "";
	for (const g of groups) {
		const nodeContent = g.nodes && g.nodes.length > 0 ? g.nodes.join('\n') : "";
		groupEditHtml += `<div class="group-item" data-gid="${g.id}">
			<input type="text" class="group-name" value="${escapeHtml(g.name)}" readonly>
			<button class="btn edit-btn" data-gid="${g.id}">编辑</button>
			<button class="btn danger" onclick="delGroup('${g.id}')">删除</button>
			<div class="node-wrap">
				<textarea class="node-area" readonly data-gid="${g.id}">${escapeHtml(nodeContent)}</textarea>
			</div>
		</div>`;
	}

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>多分组勾选订阅管理面板</title>
<script src="https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:"Microsoft Yahei",Arial,sans-serif;background:#fff;color:#333;padding:20px;line-height:1.6;}
.container{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:1fr;gap:20px;}
@media(min-width:768px){.container{grid-template-columns:1fr 1fr;}}
.card{background:#f8f8f8;border:1px solid #ccc;padding:20px;}
.card-title{font-size:18px;font-weight:600;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #ddd;padding-bottom:8px;}
.btn{background:#0066cc;color:#fff;border:none;padding:6px 16px;min-width:70px;white-space:nowrap;font-size:14px;cursor:pointer;}
.btn:hover{background:#0052a3;}
.btn.danger{background:#dd3333;}
.btn.danger:hover{background:#bb2222;}
.btn.save-green{background:#38b068;}
.btn.save-green:hover{background:#2f9357;}
.btn.small{padding:3px 10px;min-width:auto;font-size:12px;}
input,textarea{border:1px solid #ccc;padding:8px 12px;font-size:14px;background:#fff;}
input:focus,textarea:focus{border-color:#0066cc;outline:none;}
.group-name[readonly],.node-area[readonly]{background:#f0f0f0;cursor:default;}
textarea{min-height:180px;resize:vertical;margin:10px 0;width:100%;}
.group-item{padding:12px;background:#fff;border:1px solid #ddd;margin-bottom:10px;display:flex;flex-wrap:wrap;align-items:center;gap:12px;}
.node-wrap{width:100%;}
.empty-tip{color:#888;text-align:center;padding:30px 0;}
.check-wrap{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px;}
.check-item{display:flex;align-items:center;gap:4px;padding:4px 8px;background:#fff;border:1px solid #ddd;}
.sub-name-input{margin-bottom:12px;}
.sub-item{background:#fff;border:1px solid #ddd;padding:10px;margin-bottom:8px;}
.sub-header-line{display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;}
.sub-name{font-weight:bold;}
.sub-groups-small{font-size:13px;color:#666;}
.sub-url-row{display:flex;gap:8px;align-items:center;}
.sub-copy-input{flex:1;min-width:120px;}
.sub-editor{display:none;margin-top:10px;padding-top:10px;border-top:1px dashed #ddd;}
.field-label{font-size:13px;color:#555;margin:8px 0 6px;}
.field-label-row{display:flex;justify-content:space-between;align-items:center;}
.check-actions{display:flex;gap:6px;}
.order-list{margin-bottom:10px;}
.order-row{display:flex;align-items:center;gap:8px;padding:5px 8px;background:#fff;border:1px solid #ddd;margin-bottom:6px;}
.order-row.dim{background:#fafafa;}
.order-row.dim .order-name{color:#999;}
.order-badge{width:18px;text-align:center;font-size:13px;font-weight:bold;color:#0066cc;flex:none;}
.order-name{flex:1;font-size:14px;word-break:break-all;}
.order-ctrl{display:flex;gap:6px;flex:none;}
.editor-actions{display:flex;gap:8px;margin-top:4px;}
.toast-wrap{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;}
.toast{background:#333;color:#fff;padding:8px 16px;font-size:14px;border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,.18);max-width:80vw;opacity:0;transform:translateY(-10px);transition:opacity .22s ease,transform .22s ease;}
.toast.show{opacity:1;transform:translateY(0);}
.toast.ok{background:#2f9357;}
.toast.err{background:#c9302c;}
.modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:none;align-items:center;justify-content:center;padding:20px;}
.modal-box{background:#fff;border:1px solid #ddd;padding:22px 20px 16px;max-width:380px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.25);}
.modal-msg{font-size:15px;color:#333;margin-bottom:18px;line-height:1.6;word-break:break-all;}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;}
.add-group-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.add-group-inline input{width:170px;padding:6px 10px;font-size:14px;}
code{font-family:monospace;background:#eee;padding:2px 6px;}
hr{margin:15px 0;border:0;border-top:1px solid #ddd;}
.mt-10{margin-top:10px;}
</style>
</head>
<body>
<div class="toast-wrap" id="toastWrap"></div>
<div class="modal-mask" id="modalMask">
	<div class="modal-box">
		<div class="modal-msg" id="modalMsg"></div>
		<div class="modal-actions">
			<button class="btn" id="modalCancel">取消</button>
			<button class="btn danger" id="modalOk">确认</button>
		</div>
	</div>
</div>
<div class="container">
<div class="card">
<div class="card-title">
<span>节点分组管理</span>
<span class="add-group-inline">
	<input type="text" id="newGroupName" placeholder="新分组名称">
	<button class="btn" id="addGroupBtn">新增分组</button>
</span>
</div>
<div id="groupEditList">${groupEditHtml}</div>
</div>

<div class="card">
<div class="card-title">
<span>勾选分组生成订阅</span>
<button class="btn" id="createSubBtn">生成订阅链接</button>
</div>
<div class="sub-name-input">
<input type="text" id="customSubName" placeholder="可选：输入自定义订阅名称，留空自动使用分组名拼接">
</div>
<div class="check-wrap" id="groupCheckWrap">${groupCheckHtml}</div>

<hr>
<h4>已创建订阅列表（可编辑名称与分组）</h4>
<div id="subList">${subListHtml}</div>
</div>
</div>

<script>
(function(){
const origin = "${origin}";
async function postReq(data){
const res = await fetch(location.href,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
return await res.json();
}

// 轻提示：自动消失，无需点击确认（type: ok / err）
function showToast(msg, type){
	const wrap = document.getElementById("toastWrap");
	if(!wrap){ return; }
	const el = document.createElement("div");
	el.className = "toast " + (type === "err" ? "err" : "ok");
	el.textContent = msg;
	wrap.appendChild(el);
	// 触发过渡
	requestAnimationFrame(function(){ el.classList.add("show"); });
	window.setTimeout(function(){
		el.classList.remove("show");
		window.setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 260);
	}, 5000);
}
window.showToast = showToast;

// 点击输入框复制订阅链接
window.copySub = async function(inputEl){
	inputEl.select();
	// 优先用剪贴板API；被浏览器策略拦截时退回 execCommand
	try{
		await navigator.clipboard.writeText(inputEl.value);
	}catch(e){
		try{ document.execCommand("copy"); }catch(err){}
	}
	if(inputEl.setSelectionRange){
		try{ inputEl.setSelectionRange(0, inputEl.value.length); }catch(e){}
	}
	showToast("订阅链接已复制", "ok");
};

// 分组编辑逻辑
function closeAllGroupEdit(){
const n=document.querySelectorAll(".group-name");
const t=document.querySelectorAll(".node-area");
const b=document.querySelectorAll(".edit-btn");
for(let el of n) el.readOnly=true;
for(let el of t) el.readOnly=true;
for(let el of b){el.innerText="编辑";el.classList.remove("save-green");el.onclick=handleGroupEdit;}
}
function handleGroupEdit(e){
closeAllGroupEdit();
const gid=e.target.dataset.gid;
const item=document.querySelector('.group-item[data-gid="'+gid+'"]');
const nameIn=item.querySelector(".group-name");
const textArea=item.querySelector(".node-area");
nameIn.readOnly=false;textArea.readOnly=false;nameIn.focus();
e.target.innerText="保存";e.target.classList.add("save-green");
e.target.onclick=()=>saveGroup(gid);
}
async function saveGroup(gid){
const item=document.querySelector('.group-item[data-gid="'+gid+'"]');
const n=item.querySelector(".group-name").value.trim();
const t=item.querySelector(".node-area").value.split("\\n").filter(x=>x.trim());
await postReq({action:"updateGroupName",gid,name:n});
await postReq({action:"updateGroupNodes",gid,nodes:t});
location.reload();
}
// 危险操作（删除分组 / 删除订阅）二次确认：必须手动点“确认”，不会自动消失
function confirmDialog(msg){
	return new Promise(function(resolve){
		const mask = document.getElementById("modalMask");
		const msgEl = document.getElementById("modalMsg");
		const cancelBtn = document.getElementById("modalCancel");
		const okBtn = document.getElementById("modalOk");
		if(!mask || !msgEl || !cancelBtn || !okBtn){ resolve(false); return; }
		let finished = false;
		msgEl.textContent = msg;
		mask.style.display = "flex";
		cancelBtn.textContent = "取消";
		const finish = function(val){
			if(finished) return;
			finished = true;
			mask.style.display = "none";
			cancelBtn.onclick = null;
			okBtn.onclick = null;
			resolve(val);
		};
		cancelBtn.onclick = function(){ finish(false); };
		okBtn.onclick = function(){ finish(true); };
	});
}

// 新增分组：内嵌输入框，不再弹 prompt 对话框
document.getElementById("addGroupBtn").onclick = async function(){
	const inp = document.getElementById("newGroupName");
	if(!inp) return;
	const name = inp.value.trim();
	if(!name){ showToast("请先输入分组名称", "err"); inp.focus(); return; }
	await postReq({action:"addGroup",name:name});
	location.reload();
};
document.getElementById("newGroupName").addEventListener("keydown", function(ev){
	if(ev.key === "Enter"){ document.getElementById("addGroupBtn").click(); }
});

window.delGroup=async function(gid){
	const ok = await confirmDialog("确认删除该分组？绑定该分组的订阅将失效");
	if(!ok) return;
	await postReq({action:"delGroup",gid});
	location.reload();
};

// 创建订阅按钮
document.getElementById("createSubBtn").onclick=async function(){
	const checks=document.querySelectorAll("#groupCheckWrap .group-check:checked");
	const bindGids=[];
	checks.forEach(cb=>bindGids.push(cb.value));
	if(bindGids.length===0){
		showToast("请至少勾选一个分组", "err");
		return;
	}
	const customName = document.getElementById("customSubName").value.trim();
	await postReq({action:"createSubBind",bindGids,subName:customName});
	location.reload();
};

// 【新增】打开/收起某个订阅的编辑区（同时只展开一个）
window.editSubBind = function(token){
	const ed = document.getElementById("editor-"+token);
	if(!ed) return;
	const wasOpen = ed.style.display === "block";
	document.querySelectorAll(".sub-editor").forEach(function(el){ el.style.display="none"; });
	ed.style.display = wasOpen ? "none" : "block";
};
window.cancelSubBind = function(token){
	const ed = document.getElementById("editor-"+token);
	if(ed) ed.style.display="none";
};
// 编辑器内的分组序号（只对勾选的分组计数），并同步未勾选项的置灰状态
function renumberEditor(ed){
	if(!ed) return;
	let n = 0;
	ed.querySelectorAll(".order-row").forEach(function(row){
		const cb = row.querySelector(".edit-group-check");
		const badge = row.querySelector(".order-badge");
		if(cb && cb.checked){
			n++;
			if(badge) badge.textContent = String(n);
			row.classList.remove("dim");
		}else{
			if(badge) badge.textContent = "";
			row.classList.add("dim");
		}
	});
}
// 【新增】调整分组顺序：dir=-1 上移，dir=1 下移（保存后订阅内节点即按此顺序输出）
window.moveGroup = function(token, gid, dir){
	const ed = document.getElementById("editor-"+token);
	if(!ed) return;
	const row = ed.querySelector('.order-row[data-gid="' + gid + '"]');
	if(!row) return;
	const sibling = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
	if(!sibling || !sibling.classList || !sibling.classList.contains("order-row")) return;
	if(dir < 0){
		row.parentNode.insertBefore(row, sibling);
	}else{
		row.parentNode.insertBefore(row, sibling.nextElementSibling);
	}
	renumberEditor(ed);
};
// 【新增】编辑区内一键全选/清空分组
window.toggleAllGroups = function(token, val){
	const ed = document.getElementById("editor-"+token);
	if(!ed) return;
	ed.querySelectorAll(".edit-group-check").forEach(function(cb){ cb.checked = !!val; });
	renumberEditor(ed);
};
// 初始化编辑器序号，并在勾选变化时刷新
document.querySelectorAll(".sub-editor").forEach(function(ed){
	ed.querySelectorAll(".edit-group-check").forEach(function(cb){
		cb.addEventListener("change", function(){ renumberEditor(ed); });
	});
	renumberEditor(ed);
});
// 【新增】保存订阅修改：名称 + 勾选分组（token 不变，链接不变，内容即时生效）
window.saveSubBind = async function(token){
	const ed = document.getElementById("editor-"+token);
	if(!ed) return;
	const name = ed.querySelector(".edit-sub-name").value.trim();
	const gids = [];
	ed.querySelectorAll(".edit-group-check:checked").forEach(function(cb){ gids.push(cb.value); });
	if(gids.length===0){
		showToast("请至少勾选一个分组，否则订阅会变成空链接", "err");
		return;
	}
	const r = await postReq({action:"updateSubBind",token:token,subName:name,bindGids:gids});
	if(r && r.code===0){
		location.reload();
	}else{
		showToast("保存失败：" + (r && r.msg ? r.msg : "请稍后重试"), "err");
	}
};

// 编辑按钮（停止冒泡，避免和其它点击冲突）
document.querySelectorAll(".edit-sub").forEach(btn=>{
	btn.onclick=function(){ editSubBind(this.dataset.token); };
});

// 删除订阅
document.querySelectorAll(".del-sub").forEach(btn=>{
btn.onclick=async function(){
	const tok=this.dataset.token;
	const ok = await confirmDialog("确认删除该订阅，对应访问将立即失效");
	if(!ok) return;
	await postReq({action:"delSubBind",token:tok});
	location.reload();
};
});

// 绑定分组编辑按钮
document.querySelectorAll(".edit-btn").forEach(btn=>btn.onclick=handleGroupEdit);
})();
</script>
</body></html>`;

	return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}
