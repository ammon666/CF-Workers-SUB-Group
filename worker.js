// ==================== CF-Workers-SUB-Group 多分组订阅方案（移除TG推送） ====================


// 全局基础配置
let adminSecret = 'fallback-admin';
let FileName = 'CF-Workers-SUB-Group';
let SUBUpdateTime = 6;
let total = 99;
const EXPIRE_TIMESTAMP = 4102329600000;

// 外部订阅导入配置
let MainData = "";
let subConverter = "SUBAPI.cmliussss.net";
let subConfig = "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini";
let subProtocol = 'https';

// 系统常量
const KV_STORE_KEY = "SUB_GROUP_DATA";
const TG_MSG_MAX_LEN = 3800;
const FETCH_TIMEOUT = 2000;
const BYTES_PER_TB = 1099511627776;

export default {
	async fetch(request, env) {
		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
		const urlObj = new URL(request.url);

		// 读取独立管理密钥环境变量
		adminSecret = env.ADMIN_TOKEN || adminSecret;
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
			// 兼容旧订阅补充name字段
			for (const item of storeData.subBindList) {
				if (typeof item.name === "undefined") item.name = "";
			}
		}
		const { groups, subBindList } = storeData;

		// 管理面板路径判定
		const adminPath = "/" + adminSecret;
		const isAdminRoute = urlObj.pathname === adminPath || urlObj.pathname.startsWith(adminPath + "?");

		// =========== 分支1：管理面板路由 ===========
		if (isAdminRoute) {
			// POST 请求：处理分组/订阅绑定增删
			if (request.method === "POST") {
				try {
					const postBody = await request.text();
					const reqData = JSON.parse(postBody);
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
							storeData.subBindList = storeData.subBindList.filter(bind => !bind.bindGroupIds.includes(reqData.gid));
							break;
						// 订阅绑定操作：新建订阅插入数组头部，实现置顶
						case "createSubBind":
							const newSubTok = generateRandomToken(24);
							storeData.subBindList.unshift({
								token: newSubTok,
								bindGroupIds: reqData.bindGids,
								name: (reqData.subName || "").trim()
							});
							break;
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

			// 非法访问管理路径拦截，移除TG推送
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
		// 无匹配订阅绑定=权限不足，移除TG推送
		if (!matchedBind) {
			if (env.URL302) return Response.redirect(env.URL302, 302);
			if (env.URL) return await proxyURL(env.URL, urlObj);
			return new Response("Access Denied: Valid subscription token required", { status: 403 });
		}

		// 聚合绑定分组内所有节点生成订阅
		let allNodeText = "";
		for (const gid of matchedBind.bindGroupIds) {
			const g = groups.find(item => item.id === gid);
			if (g && Array.isArray(g.nodes)) {
				allNodeText += g.nodes.join('\n') + '\n';
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

		const now = Date.now();
		const usedFlow = Math.floor(((EXPIRE_TIMESTAMP - now) / EXPIRE_TIMESTAMP * total * BYTES_PER_TB) / 2);
		const totalFlow = total * BYTES_PER_TB;
		const expireTime = Math.floor(EXPIRE_TIMESTAMP / 1000);

		const headers = {
			"content-type": "text/plain; charset=utf-8",
			"Profile-Update-Interval": String(SUBUpdateTime),
			"Profile-web-page-url": urlObj.origin,
			"Subscription-Userinfo": `upload=${usedFlow}; download=${usedFlow}; total=${totalFlow}; expire=${expireTime}`
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

async function ADD(envadd) {
	let addtext = envadd.replace(/[	"'|\r\n]+/g, '\n').replace(/\n+/g, '\n');
	if (addtext.charAt(0) === '\n') addtext = addtext.slice(1);
	if (addtext.length > 0 && addtext.charAt(addtext.length - 1) === '\n') addtext = addtext.slice(0, -1);
	return addtext.split('\n');
}

function nginxDenied() {
	return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Access Denied</title></head><body><h1>403 Access Denied</h1><p>Invalid admin access</p></body></html>';
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

// 管理面板页面渲染：订阅紧凑布局、点击复制、删除按钮同行右侧
async function renderAdminPanel(request, env, groups, subBindList, urlObj) {
	const origin = urlObj.origin;

	// 分组多选HTML
	let groupCheckHtml = "";
	if (groups.length === 0) {
		groupCheckHtml = '<div class="empty-tip">暂无分组，请先新增分组</div>';
	} else {
		for (const g of groups) {
			groupCheckHtml += `<label class="check-item">
				<input type="checkbox" class="group-check" value="${g.id}" data-gname="${g.name}">
				<span>${g.name}</span>
			</label>`;
		}
	}

	// 现有订阅列表，紧凑布局，隐藏单独token，链接+删除按钮同行，点击输入框复制
	let subListHtml = "";
	if (subBindList.length === 0) {
		subListHtml = '<p class="empty-tip">暂无生成的订阅，勾选分组后创建</p>';
	} else {
		for (const bind of subBindList) {
			const subUrl = `${origin}?token=${bind.token}`;
			// 获取绑定分组名称
			const bindNames = bind.bindGroupIds.map(gid => {
				const g = groups.find(x => x.id === gid);
				return g ? g.name : "[已删除分组]";
			}).join("、");
			// 展示名称：自定义名称优先
			const displayName = bind.name || `订阅-${bindNames}`;
			subListHtml += `<div class="sub-item">
				<div class="sub-header-line">
					<span class="sub-name">${displayName}</span>
					<span class="sub-groups-small">(${bindNames})</span>
				</div>
				<div class="sub-url-row">
					<input class="sub-copy-input" readonly onclick="copySub(this)" value="${subUrl}">
					<button class="btn danger del-sub" data-token="${bind.token}">删除</button>
				</div>
			</div>`;
		}
	}

	// 分组编辑区域HTML
	let groupEditHtml = "";
	for (const g of groups) {
		const nodeContent = g.nodes && g.nodes.length > 0 ? g.nodes.join('\n') : "";
		groupEditHtml += `<div class="group-item" data-gid="${g.id}">
			<input type="text" class="group-name" value="${g.name}" readonly>
			<button class="btn edit-btn" data-gid="${g.id}">编辑</button>
			<button class="btn danger" onclick="delGroup('${g.id}')">删除</button>
			<div class="node-wrap">
				<textarea class="node-area" readonly data-gid="${g.id}">${nodeContent}</textarea>
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
code{font-family:monospace;background:#eee;padding:2px 6px;}
hr{margin:15px 0;border:0;border-top:1px solid #ddd;}
.mt-10{margin-top:10px;}
</style>
</head>
<body>
<div class="container">
<div class="card">
<div class="card-title">
<span>节点分组管理</span>
<button class="btn" onclick="addNewGroup()">新增分组</button>
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
<h4>已创建订阅列表</h4>
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

// 点击输入框复制订阅链接
window.copySub = async function(inputEl){
	inputEl.select();
	await navigator.clipboard.writeText(inputEl.value);
	alert("订阅链接已复制");
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
window.addNewGroup=async function(){
const name=prompt("输入分组名称","新分组");
if(!name)return;
await postReq({action:"addGroup",name});
location.reload();
};
window.delGroup=async function(gid){
if(!confirm("确认删除该分组？绑定该分组的订阅将失效"))return;
await postReq({action:"delGroup",gid});
location.reload();
};

// 创建订阅按钮
document.getElementById("createSubBtn").onclick=async function(){
	const checks=document.querySelectorAll("#groupCheckWrap .group-check:checked");
	const bindGids=[];
	checks.forEach(cb=>bindGids.push(cb.value));
	if(bindGids.length===0){
		alert("请至少勾选一个分组");
		return;
	}
	const customName = document.getElementById("customSubName").value.trim();
	await postReq({action:"createSubBind",bindGids,subName:customName});
	location.reload();
};

// 删除订阅
document.querySelectorAll(".del-sub").forEach(btn=>{
btn.onclick=async function(){
	const tok=this.dataset.token;
	if(!confirm("确认删除该订阅，对应访问将立即失效"))return;
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