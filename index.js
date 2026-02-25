// CPI - Copilot Interceptor
// OpenAI (/chat/completions) 또는 Anthropic (/v1/messages) 엔드포인트 선택 가능
import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "CPI";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const COPILOT_API_BASE = "https://api.githubcopilot.com";
const COPILOT_INTERNAL_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

const defaultSettings = {
    enabled: true,
    useVscodeHeaders: true,
    removePrefill: true,
    trimAssistant: true,
    forceLastUser: true,
    basicAuthCompat: false,
    debugLog: true,
    endpoint: "anthropic",  // "openai", "anthropic", "anthropic-thinking", "passthrough"
    thinkingBudget: 10000,  // thinking budget_tokens
    adaptiveThinking: false, // adaptive thinking (Opus 4.6+, Copilot 미지원 가능)

    token: "",  // 현재 선택된 토큰
    tokens: [],  // 저장된 토큰 목록 [{name, value}]
    chatVersion: "0.38.2026020704",
    codeVersion: "1.109.0",
};

const LOG_MAX = 500;

// ============================================================
// 디버그 로그
// ============================================================
const DebugLog = {
    entries: [],

    add(level, ...args) {
        const s = getSettings();
        const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
        const msg = args.map(a =>
            typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)
        ).join(" ");

        this.entries.push({ time, level, msg });
        if (this.entries.length > LOG_MAX) this.entries.shift();

        if (level === "ERROR") console.error(`[CPI] ${msg}`);
        else if (level === "WARN") console.warn(`[CPI] ${msg}`);
        else console.log(`[CPI] ${msg}`);

        if (s.debugLog) this.render();
    },

    info(...a) { this.add("INFO", ...a); },
    warn(...a) { this.add("WARN", ...a); },
    error(...a) { this.add("ERROR", ...a); },

    request(method, url, headers, body) {
        this.add("REQ", `━━━ 요청 ━━━`);
        this.add("REQ", `${method} ${url}`);
        this.add("REQ", `모델: ${body?.model || "?"} | stream: ${body?.stream} | temp: ${body?.temperature ?? "?"} | max_tokens: ${body?.max_tokens ?? "?"}`);

        const safe = { ...headers };
        if (safe["Authorization"]) safe["Authorization"] = safe["Authorization"].substring(0, 20) + "...";
        this.add("REQ", `헤더: ${JSON.stringify(safe)}`);

        // messages 개별 출력
        const msgs = body?.messages || [];
        if (msgs.length > 0) {
            this.add("REQ", `━━━ Messages (${msgs.length}개) ━━━`);
            msgs.forEach((m, i) => {
                const c = typeof m.content === "string" ? m.content
                    : Array.isArray(m.content) ? m.content.map(b => b.text || "").join("") 
                    : JSON.stringify(m.content);
                this.add("REQ", `[${i}] role=${m.role} (${c.length}자)\n${c}`);
            });
            this.add("REQ", `━━━ Messages 끝 ━━━`);
        }

        // system (Anthropic 포맷)
        if (body?.system) {
            const sysText = Array.isArray(body.system) ? body.system.map(s => s.text || "").join("") : String(body.system);
            this.add("REQ", `━━━ System (${sysText.length}자) ━━━\n${sysText}`);
        }

        const params = { ...body };
        delete params.messages;
        delete params.system;
        this.add("REQ", `기타: ${JSON.stringify(params)}`);
    },

    response(status, statusText, bodyPreview) {
        this.add("RES", `━━━ 응답 ━━━`);
        this.add("RES", `상태: ${status} ${statusText || ""}`);
        if (bodyPreview) {
            this.add("RES", `내용: ${bodyPreview.substring(0, 300)}${bodyPreview.length > 300 ? "..." : ""}`);
        }
    },

    render() {
        const el = $("#cpi_log_content");
        if (!el.length) return;
        const colors = { INFO: "#8bc34a", WARN: "#FF9800", ERROR: "#f44336", REQ: "#64b5f6", RES: "#ce93d8" };
        const FOLD_THRESHOLD = 200;
        const html = this.entries.map((e, idx) => {
            const c = colors[e.level] || "#ccc";
            const escaped = escapeHtml(e.msg);
            const needsFold = escaped.length > FOLD_THRESHOLD;
            const header = `<span style="color:#666;">[${e.time}]</span> <span style="color:${c};font-weight:bold;">[${e.level}]</span> `;
            if (needsFold) {
                const preview = escaped.substring(0, FOLD_THRESHOLD).replace(/\n/g, "<br>");
                const full = escaped.replace(/\n/g, "<br>");
                return `<div style="margin:1px 0;">${header}<span class="cpi-fold" data-idx="${idx}"><span class="cpi-fold-short" style="color:#ddd;">${preview}<span class="cpi-fold-btn" data-action="expand" style="color:#64b5f6;cursor:pointer;margin-left:4px;">▼ 펼치기</span></span><span class="cpi-fold-long" style="display:none;color:#ddd;">${full}<br><span class="cpi-fold-btn" data-action="collapse" style="color:#64b5f6;cursor:pointer;">▲ 접기</span></span></span></div>`;
            }
            const f = escaped.replace(/\n/g, "<br>");
            return `<div style="margin:1px 0;">${header}<span style="color:#ddd;">${f}</span></div>`;
        }).join("");
        el.html(html);
        // 자동 스크롤 (맨 아래로)
        requestAnimationFrame(() => {
            el.scrollTop(el[0]?.scrollHeight || 0);
        });
    },

    clear() { this.entries = []; this.render(); },
};

function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// 유틸
// ============================================================
/** 토큰: SillyTavern 연결 프로필의 API key에서 읽기 */
let _cachedApiKey = "";

function getToken(requestBody) {
    // 0. CPI 설정에 직접 입력한 토큰 (최우선)
    const s = getSettings();
    if (s.token && s.token.trim()) {
        return s.token.trim();
    }
    // 1. SillyTavern 연결 프로필 API key 필드
    const fields = ['api_key_custom', 'api_key', 'reverse_proxy_password', 'proxy_password'];
    for (const f of fields) {
        const val = requestBody?.[f];
        if (val && typeof val === "string" && val.trim()) {
            _cachedApiKey = val.trim();
            DebugLog.info(`토큰: ${f} (${val.substring(0, 10)}...)`);
            return _cachedApiKey;
        }
    }
    // 2. custom_include_headers에서 Authorization 추출
    const headers = requestBody?.custom_include_headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        const auth = headers["Authorization"] || headers["authorization"];
        if (auth) {
            const token = auth.replace(/^Bearer\s+/i, "").trim();
            if (token) {
                _cachedApiKey = token;
                DebugLog.info(`토큰: custom_include_headers (${token.substring(0, 10)}...)`);
                return _cachedApiKey;
            }
        }
        for (const [k, v] of Object.entries(headers)) {
            if (typeof v === "string" && v.startsWith("gho_")) {
                _cachedApiKey = v.trim();
                DebugLog.info(`토큰: custom_include_headers.${k} (${v.substring(0, 10)}...)`);
                return _cachedApiKey;
            }
        }
    }
    // 3. 캐시된 토큰
    if (_cachedApiKey) return _cachedApiKey;
    // 4. GCM 폴백
    const gcm = extension_settings["GCM"]?.token;
    if (gcm) {
        DebugLog.info(`토큰: GCM 폴백 (${gcm.substring(0, 10)}...)`);
        return gcm;
    }
    return "";
}

function hasAnyToken() {
    const s = getSettings();
    return !!(s.token?.trim() || _cachedApiKey || extension_settings["GCM"]?.token);
}

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = JSON.parse(JSON.stringify(defaultSettings));
    }
    return extension_settings[extensionName];
}

function saveSettings() { saveSettingsDebounced(); }

// ============================================================
// OpenAI → Anthropic 포맷 변환
// ============================================================
// ============================================================
function convertToAnthropicFormat(messages, model, params) {
    const openAIChats = structuredClone(messages);

    // 1) 첫 assistant 등장 전까지의 메시지를 system 파라미터로 추출
    let splitIndex = openAIChats.findIndex(m => m.role === "assistant");
    if (splitIndex === -1) {
        splitIndex = Math.max(0, openAIChats.length - 1);
    }

    let systemText = "";
    for (let i = 0; i < splitIndex; i++) {
        const content = typeof openAIChats[i].content === "string"
            ? openAIChats[i].content.trim() : "";
        if (!content) continue;
        if (systemText) systemText += "\n\n";
        systemText += content;
    }
    openAIChats.splice(0, splitIndex);

    // 2) 첫 메시지가 user가 아니면 더미 추가
    if (openAIChats.length === 0 || openAIChats[0].role !== "user") {
        openAIChats.unshift({ role: "user", content: "Start" });
    }

    // 3) messages 변환 (같은 role 연속 병합 + system→user 변환)
    const anthropicMessages = [];
    for (const msg of openAIChats) {
        let content = "";
        if (typeof msg.content === "string") {
            content = msg.content.trim();
        } else if (Array.isArray(msg.content)) {
            content = msg.content.map(b => b.text || "").join("").trim();
        }
        if (!content) continue;  // 빈 메시지 스킵
        const last = anthropicMessages.length > 0 ? anthropicMessages[anthropicMessages.length - 1] : null;

        if (msg.role === "system") {
            const text = "system: " + content;
            if (last?.role === "user") {
                last.content[0].text += "\n\n" + text;
            } else {
                anthropicMessages.push({ role: "user", content: [{ type: "text", text }] });
            }
        } else if (msg.role === "user" || msg.role === "assistant") {
            if (last?.role === msg.role) {
                last.content[0].text += "\n\n" + content;
            } else {
                anthropicMessages.push({ role: msg.role, content: [{ type: "text", text: content }] });
            }
        }
    }

    // 4) messages가 비어있으면 더미
    if (anthropicMessages.length === 0) {
        anthropicMessages.push({ role: "user", content: [{ type: "text", text: "Start" }] });
    }

    // 5) 마지막이 user인지 확인
    if (anthropicMessages[anthropicMessages.length - 1].role !== "user") {
        anthropicMessages.push({ role: "user", content: [{ type: "text", text: "Continue" }] });
    }

    // 6) user↔assistant 교대 검증 — 연속 같은 role 있으면 병합
    const validated = [];
    for (const msg of anthropicMessages) {
        const text = msg.content[0]?.text?.trim();
        if (!text) continue;  // 빈 text 최종 제거
        msg.content[0].text = text;
        const last = validated.length > 0 ? validated[validated.length - 1] : null;
        if (last && last.role === msg.role) {
            last.content[0].text += "\n\n" + text;
        } else {
            validated.push(msg);
        }
    }

    // 검증 후 비어있으면 더미
    if (validated.length === 0) {
        validated.push({ role: "user", content: [{ type: "text", text: "Start" }] });
    }
    if (validated[validated.length - 1].role !== "user") {
        validated.push({ role: "user", content: [{ type: "text", text: "Continue" }] });
    }

    // 7) body 구성
    const body = {
        model: model,
        messages: validated,
        max_tokens: params.max_tokens || 8192,
    };

    if (systemText) {
        body.system = [{ type: "text", text: systemText }];
    }

    // thinking 모드
    if (params.thinking) {
        if (params.adaptiveThinking) {
            body.thinking = { type: "adaptive" };
            DebugLog.info("Adaptive Thinking 활성화");
        } else {
            const budget = params.thinkingBudget || 10000;
            body.thinking = { type: "enabled", budget_tokens: budget };
            if (body.max_tokens <= budget) {
                body.max_tokens = budget + 4096;
            }
        }
        // thinking 사용 시 temperature 설정 불가 (Anthropic 제한)
    } else {
        // temperature 클램핑 (Anthropic: 0.0~1.0)
        if (params.temperature != null) {
            body.temperature = Math.min(Math.max(params.temperature, 0), 1.0);
        }
        // top_p: temperature 없을 때만
        if (params.temperature == null && params.top_p != null) {
            body.top_p = Math.min(Math.max(params.top_p, 0), 1.0);
        }
    }
    if (params.stream != null) body.stream = params.stream;

    return body;
}

// ============================================================
// Copilot 인터셉터
// ============================================================
const Interceptor = {
    tidToken: "",
    tidTokenExpiry: 0,
    machineId: "",
    sessionId: "",
    originalFetch: null,
    active: false,

    async refreshTidToken(apiKey) {
        if (!apiKey) return "";
        if (this.tidToken && Date.now() < this.tidTokenExpiry - 60000) {
            DebugLog.info("tid 토큰 캐시 사용");
            return this.tidToken;
        }
        try {
            DebugLog.info("tid 토큰 갱신 요청...");
            const res = await this.originalFetch.call(window, COPILOT_INTERNAL_TOKEN_URL, {
                method: "GET",
                headers: { "Accept": "application/json", "Authorization": `Bearer ${apiKey}`, "Origin": "vscode-file://vscode-app" },
            });
            if (!res.ok) { DebugLog.error("tid 갱신 실패:", res.status); return ""; }
            const data = await res.json();
            if (data.token && data.expires_at) {
                this.tidToken = data.token;
                this.tidTokenExpiry = data.expires_at * 1000;
                DebugLog.info("tid 토큰 갱신 성공");
                return this.tidToken;
            }
            return "";
        } catch (e) { DebugLog.error("tid 오류:", String(e)); return ""; }
    },

    buildVscodeHeaders() {
        const s = getSettings();
        const chatVer = s.chatVersion || "0.38.2026020704";
        const codeVer = s.codeVersion || "1.109.0";
        if (!this.machineId) {
            this.machineId = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
        }
        if (!this.sessionId) {
            this.sessionId = (crypto.randomUUID?.() || Date.now().toString()) + Date.now().toString();
        }
        return {
            "Copilot-Integration-Id": "vscode-chat",
            "Editor-Plugin-Version": `copilot-chat/${chatVer}`,
            "Editor-Version": `vscode/${codeVer}`,
            "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/${codeVer} Chrome/142.0.7444.265 Electron/39.4.1 Safari/537.36`,
            "Vscode-Machineid": this.machineId,
            "Vscode-Sessionid": this.sessionId,
            "X-Github-Api-Version": "2025-10-01",
            "X-Initiator": "user",
            "X-Interaction-Id": crypto.randomUUID?.() || Date.now().toString(),
            "X-Interaction-Type": "conversation-panel",
            "X-Request-Id": crypto.randomUUID?.() || Date.now().toString(),
            "X-Vscode-User-Agent-Library-Version": "electron-fetch",
        };
    },

    async interceptAndSend(requestBody) {
        const token = getToken(requestBody);
        if (!token) throw new Error("토큰 없음 — API key 또는 GCM 토큰 필요");

        const s = getSettings();
        const isAnthropic = s.endpoint === "anthropic" || s.endpoint === "anthropic-thinking";
        const isThinking = s.endpoint === "anthropic-thinking";
        const isPassthrough = s.endpoint === "passthrough";
        const url = isAnthropic
            ? `${COPILOT_API_BASE}/v1/messages`
            : `${COPILOT_API_BASE}/chat/completions`;

        DebugLog.info(`엔드포인트: ${s.endpoint}${isThinking ? " (추론)" : ""} → ${url}`);

        // 헤더
        const headers = { "Content-Type": "application/json" };

        if (isAnthropic) {
            headers["Accept"] = "application/json";
        } else {
            // VSCode Copilot은 스트리밍 여부에 따라 Accept 헤더를 다르게 보냄
            headers["Accept"] = requestBody.stream ? "text/event-stream" : "application/json";
        }

        if (s.useVscodeHeaders) {
            const tidToken = await this.refreshTidToken(token);
            headers["Authorization"] = `Bearer ${tidToken || token}`;
            Object.assign(headers, this.buildVscodeHeaders());
            DebugLog.info("VSCode 위장 헤더 적용");
        } else {
            headers["Authorization"] = `Bearer ${token}`;
            headers["Copilot-Integration-Id"] = "vscode-chat";
        }

        // body 정리 (공통)
        let body = { ...requestBody };
        delete body.custom_url;
        delete body.api_key_custom;
        delete body.reverse_proxy;
        delete body.proxy_password;
        for (const key of Object.keys(body)) {
            if (body[key] === undefined) delete body[key];
        }

        if (isPassthrough) {
            // === 패스스루: SillyTavern 전용 파라미터만 제거하고 그대로 전달 ===
            delete body.chat_completion_source;
            delete body.user_name;
            delete body.char_name;
            delete body.group_names;
            delete body.enable_web_search;
            delete body.request_images;
            delete body.request_image_resolution;
            delete body.request_image_aspect_ratio;
            delete body.custom_prompt_post_processing;
            delete body.custom_include_body;
            delete body.custom_exclude_body;
            delete body.custom_include_headers;
            delete body.type;

            // 불필요한 SillyTavern 전용 필드 제거
            delete body.include_reasoning;
            delete body.reasoning_effort;

            // 빈 content 메시지 제거
            if (Array.isArray(body.messages)) {
                body.messages = body.messages.filter(m => {
                    const c = typeof m.content === "string" ? m.content.trim() :
                        Array.isArray(m.content) ? m.content.map(b => b.text || "").join("").trim() : "";
                    return !!c;
                });
            }

            DebugLog.info("패스스루 모드: SillyTavern 파라미터 정리 후 전달");

            // 패스스루 body 상세 디버그
            DebugLog.info(`  [패스스루 body] 키: [${Object.keys(body).join(", ")}]`);
            if (body.messages?.length > 0) {
                const roles = body.messages.map((m, i) => `[${i}]${m.role}`).join(" ");
                DebugLog.info(`  [패스스루 body] roles: ${roles}`);
            }

        } else if (isAnthropic) {
            // === Anthropic 포맷 변환 ===
            DebugLog.info("OpenAI → Anthropic 포맷 변환 중...");

            // 변환 전 원본 로그
            if (body.messages?.length > 0) {
                const roles = body.messages.map((m, i) => `[${i}]${m.role}`).join(" ");
                DebugLog.info(`변환 전 roles: ${roles}`);
            }

            // temperature + top_p 동시 전송 방지
            if (body.temperature != null && body.top_p != null) {
                DebugLog.warn(`top_p 제거 (temperature와 동시 사용 불가)`);
                delete body.top_p;
            }

            const model = body.model || "claude-sonnet-4.5";
            const params = {
                max_tokens: body.max_tokens || 8192,
                temperature: body.temperature,
                top_p: body.top_p,
                stream: body.stream,
                thinking: isThinking,
                thinkingBudget: s.thinkingBudget || 10000,
                adaptiveThinking: !!s.adaptiveThinking,
            };

            body = convertToAnthropicFormat(body.messages || [], model, params);
            DebugLog.info(`변환 완료: system ${body.system ? "있음" : "없음"}, messages ${body.messages.length}개${isThinking ? ", 추론 ON" : ""}`);

        } else {
            // === OpenAI 포맷 보정 ===

            // temperature + top_p 동시 전송 방지
            if (body.temperature != null && body.top_p != null) {
                DebugLog.warn(`top_p 제거 (temperature와 동시 사용 불가)`);
                delete body.top_p;
            }

            // SillyTavern 전용 파라미터 정리
            delete body.chat_completion_source;
            delete body.user_name;
            delete body.char_name;
            delete body.group_names;
            delete body.include_reasoning;
            delete body.reasoning_effort;
            delete body.enable_web_search;
            delete body.request_images;
            delete body.custom_prompt_post_processing;
            delete body.custom_include_body;
            delete body.custom_exclude_body;
            delete body.custom_include_headers;
            delete body.type;

            // 프리필 제거
            if (s.removePrefill && body.messages?.length > 0) {
                let removed = 0;
                while (body.messages.length > 1 && body.messages[body.messages.length - 1].role === "assistant") {
                    const r = body.messages.pop();
                    DebugLog.warn(`프리필 제거: [${r.role}]`);
                    removed++;
                }
                if (removed > 0) DebugLog.info(`${removed}개 프리필 제거됨`);
            }

            // assistant trailing whitespace trim
            if (s.trimAssistant && body.messages?.length > 0) {
                for (const m of body.messages) {
                    if (m.role === "assistant" && typeof m.content === "string") {
                        const orig = m.content;
                        m.content = m.content.trimEnd();
                        if (orig !== m.content) {
                            DebugLog.warn(`assistant 끝 공백 제거 (${orig.length} → ${m.content.length}자)`);
                        }
                    }
                }
            }

            // 마지막 메시지 user 강제
            if (s.forceLastUser && body.messages?.length > 0) {
                const last = body.messages[body.messages.length - 1];
                if (last.role !== "user") {
                    DebugLog.warn(`마지막 role 변환: ${last.role} → user`);
                    last.role = "user";
                }
            }
        }

        // 디버그 로그
        DebugLog.request("POST", url, headers, body);

        // ━━━ 요청 body 핵심 파라미터 디버그 ━━━
        DebugLog.info(`━━━ 요청 분석 ━━━`);
        DebugLog.info(`  모드: ${s.endpoint}`);
        DebugLog.info(`  URL: ${url}`);
        DebugLog.info(`  모델: ${body.model || "(없음)"}`);
        DebugLog.info(`  thinking 필드: ${body.thinking ? JSON.stringify(body.thinking) : "❌ 없음"}`);
        if (isPassthrough) {
            DebugLog.info(`  패스스루 body 키: [${Object.keys(body).join(", ")}]`);
        }
        DebugLog.info(`  max_tokens: ${body.max_tokens}`);
        DebugLog.info(`  temperature: ${body.temperature ?? "(없음)"}`);
        DebugLog.info(`  stream: ${body.stream ?? false}`);
        DebugLog.info(`  messages: ${body.messages?.length || 0}개`);
        if (body.system) {
            const sysLen = Array.isArray(body.system) ? body.system.map(s => s.text?.length || 0).reduce((a,b) => a+b, 0) : (typeof body.system === "string" ? body.system.length : 0);
            DebugLog.info(`  system 길이: ${sysLen}자`);
        }
        const totalMsgLen = (body.messages || []).reduce((sum, m) => {
            if (typeof m.content === "string") return sum + m.content.length;
            if (Array.isArray(m.content)) return sum + m.content.reduce((s, b) => s + (b.text?.length || 0), 0);
            return sum;
        }, 0);
        DebugLog.info(`  메시지 총 길이: ${totalMsgLen}자`);
        DebugLog.info(`━━━━━━━━━━━━━━━`);

        // 프록시 요청
        const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
        const credentials = s.basicAuthCompat ? "include" : "omit";
        DebugLog.info(`credentials: ${credentials}`);

        const startTime = Date.now();
        DebugLog.info(`⏱️ fetch 시작...`);
        const response = await this.originalFetch.call(window, proxyUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            credentials,
        });
        const elapsed = Date.now() - startTime;

        if (!response.ok) {
            const errText = await response.clone().text();
            DebugLog.response(response.status, response.statusText, errText);
            DebugLog.error(`❌ 요청 실패 (${elapsed}ms)`);
            DebugLog.error(`  status: ${response.status}`);
            DebugLog.error(`  에러 내용: ${errText.substring(0, 500)}`);

            // Anthropic 에러를 SillyTavern이 읽을 수 있는 포맷으로 변환
            if (isAnthropic) {
                let errMsg = `${response.status} ${response.statusText}`;
                try {
                    const errData = JSON.parse(errText);
                    errMsg = errData.error?.message || errData.message || errMsg;
                } catch {}
                return new Response(JSON.stringify({
                    error: { message: errMsg, type: "api_error", code: response.status },
                }), {
                    status: response.status,
                    headers: { "Content-Type": "application/json" },
                });
            }
        } else {
            DebugLog.response(response.status, response.statusText, "(응답 수신)");
            DebugLog.info(`✅ 요청 성공 (${elapsed}ms)`);
            DebugLog.info(`  ⏱️ 네트워크 소요: ${elapsed}ms (${(elapsed/1000).toFixed(1)}초)`);
            // 응답 헤더 전체 덤프
            const respHeaders = {};
            response.headers.forEach((v, k) => { respHeaders[k] = v; });
            DebugLog.info(`  응답 헤더: ${JSON.stringify(respHeaders)}`);
        }

        // Anthropic 응답을 OpenAI 포맷으로 변환 (SillyTavern이 파싱할 수 있도록)
        if (isAnthropic && response.ok) {
            return this.convertAnthropicResponse(response, body.stream);
        }

        // ━━━ passthrough/openai: 응답을 그대로 반환 (다른 확장 호환성 보장) ━━━
        // 디버그 로그도 response를 건드리므로 완전히 제거

        return response;
    },

    /**
     * Anthropic 응답을 OpenAI Chat Completion 포맷으로 변환
     * SillyTavern은 OpenAI 포맷을 기대하므로
     */
    async convertAnthropicResponse(response, isStream) {
        if (isStream) {
            // 스트리밍: Anthropic SSE → OpenAI SSE 변환
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = ""; // 불완전한 라인 버퍼
            let inThinking = false; // thinking 블록 상태 추적
            let thinkingAccum = ""; // 추론 내용 누적
            let textAccum = ""; // 본문 내용 누적
            let streamStartTime = Date.now();
            let firstChunkTime = null;

            const stream = new ReadableStream({
                async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                        // ━━━ 스트리밍 완료 요약 ━━━
                        const streamElapsed = Date.now() - streamStartTime;
                        const ttfb = firstChunkTime ? firstChunkTime - streamStartTime : 0;
                        DebugLog.info(`━━━ 스트리밍 완료 ━━━`);
                        DebugLog.info(`  총 소요: ${streamElapsed}ms (${(streamElapsed/1000).toFixed(1)}초)`);
                        DebugLog.info(`  TTFB (첫 청크): ${ttfb}ms`);
                        DebugLog.info(`  본문: ${textAccum.length}자`);
                        if (thinkingAccum) {
                            DebugLog.info(`  ⚡ 추론: ${thinkingAccum.length}자`);
                            DebugLog.add("REQ", `━━━ 추론 내용 ━━━\n${thinkingAccum}\n━━━ 추론 끝 ━━━`);
                        } else {
                            DebugLog.info(`  추론: ❌ 없음`);
                        }
                        DebugLog.info(`━━━━━━━━━━━━━━━`);
                        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                        controller.close();
                        return;
                    }

                    if (!firstChunkTime) firstChunkTime = Date.now();

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    // 마지막 줄은 불완전할 수 있으므로 버퍼에 보관
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        const dataStr = line.substring(6).trim();
                        if (!dataStr) continue;

                        try {
                            const event = JSON.parse(dataStr);

                            // message_start — 모델/usage 정보
                            if (event.type === "message_start" && event.message) {
                                DebugLog.info(`[스트림] message_start: 모델=${event.message.model || "?"}`);
                                if (event.message.usage) {
                                    DebugLog.info(`[스트림] input_tokens: ${event.message.usage.input_tokens || 0}`);
                                }
                            }
                            // message_delta — stop_reason, output usage
                            else if (event.type === "message_delta") {
                                if (event.usage) {
                                    DebugLog.info(`[스트림] output_tokens: ${event.usage.output_tokens || 0}`);
                                }
                                if (event.delta?.stop_reason) {
                                    DebugLog.info(`[스트림] stop_reason: ${event.delta.stop_reason}`);
                                }
                            }

                            // thinking 블록 시작
                            if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
                                inThinking = true;
                                const tag = { choices: [{ delta: { content: "<thinking>\n" }, index: 0 }] };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tag)}\n\n`));
                            }
                            // thinking delta
                            else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
                                thinkingAccum += event.delta.thinking || "";
                                const chunk = { choices: [{ delta: { content: event.delta.thinking }, index: 0 }] };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                            }
                            // redacted_thinking — Claude가 추론을 검열했을 때
                            else if (event.type === "content_block_delta" && event.delta?.type === "redacted_thinking") {
                                if (!inThinking) {
                                    inThinking = true;
                                    const tag = { choices: [{ delta: { content: "<thinking>\n" }, index: 0 }] };
                                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tag)}\n\n`));
                                }
                                const redacted = { choices: [{ delta: { content: "\n[REDACTED]\n" }, index: 0 }] };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(redacted)}\n\n`));
                                DebugLog.warn("[스트림] redacted_thinking 감지");
                            }
                            // content 블록 시작 (text) — thinking 끝
                            else if (event.type === "content_block_start" && event.content_block?.type === "text" && inThinking) {
                                const tag = { choices: [{ delta: { content: "\n</thinking>\n\n" }, index: 0 }] };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tag)}\n\n`));
                                inThinking = false;
                            }
                            // text delta
                            else if (event.type === "content_block_delta" && event.delta?.text) {
                                textAccum += event.delta.text || "";
                                const openAIChunk = {
                                    choices: [{ delta: { content: event.delta.text }, index: 0 }],
                                };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                            }
                            // 스트림 종료
                            else if (event.type === "message_stop") {
                                if (inThinking) {
                                    const tag = { choices: [{ delta: { content: "\n</thinking>\n\n" }, index: 0 }] };
                                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tag)}\n\n`));
                                    inThinking = false;
                                }
                                controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                            }
                            // 스트림 중 에러
                            else if (event.type === "error") {
                                const errMsg = event.error?.message || "Unknown error";
                                DebugLog.error(`[스트림] 에러 이벤트: ${errMsg}`);
                                if (inThinking) {
                                    const tag = { choices: [{ delta: { content: "\n</thinking>\n\n" }, index: 0 }] };
                                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tag)}\n\n`));
                                    inThinking = false;
                                }
                                const errChunk = { choices: [{ delta: { content: `\n[Error: ${errMsg}]\n` }, index: 0 }] };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errChunk)}\n\n`));
                            }
                        } catch { /* skip malformed JSON */ }
                    }
                },
            });

            return new Response(stream, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        } else {
            // 비스트리밍: Anthropic JSON → OpenAI JSON 변환
            let data;
            try {
                data = await response.json();
            } catch (e) {
                DebugLog.error("Anthropic 응답 JSON 파싱 실패:", String(e));
                return new Response(JSON.stringify({
                    choices: [{ message: { role: "assistant", content: "[CPI] 응답 파싱 실패" }, index: 0, finish_reason: "stop" }],
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }

            const thinkingText = (data.content || [])
                .filter(b => b.type === "thinking")
                .map(b => b.thinking)
                .join("");

            const text = (data.content || [])
                .filter(b => b.type === "text")
                .map(b => b.text)
                .join("");

            // ━━━ 응답 상세 디버그 ━━━
            DebugLog.info(`━━━ 응답 분석 ━━━`);
            DebugLog.info(`  모델: ${data.model || "(없음)"}`);
            DebugLog.info(`  stop_reason: ${data.stop_reason || "(없음)"}`);
            const contentTypes = (data.content || []).map(b => b.type);
            DebugLog.info(`  content 블록: [${contentTypes.join(", ")}] (${contentTypes.length}개)`);
            if (data.usage) {
                DebugLog.info(`  input_tokens: ${data.usage.input_tokens || 0}`);
                DebugLog.info(`  output_tokens: ${data.usage.output_tokens || 0}`);
                if (data.usage.cache_creation_input_tokens) {
                    DebugLog.info(`  cache_creation: ${data.usage.cache_creation_input_tokens}`);
                }
                if (data.usage.cache_read_input_tokens) {
                    DebugLog.info(`  cache_read: ${data.usage.cache_read_input_tokens}`);
                }
            }
            DebugLog.info(`  본문 길이: ${text.length}자`);
            if (thinkingText) {
                DebugLog.info(`  ⚡ 추론 발견: ${thinkingText.length}자`);
                DebugLog.add("REQ", `━━━ 추론 내용 ━━━\n${thinkingText}\n━━━ 추론 끝 ━━━`);
            } else {
                DebugLog.info(`  추론: ❌ 없음`);
            }
            DebugLog.info(`━━━━━━━━━━━━━━━`);

            // thinking이 있으면 <thinking> 태그로 감싸서 앞에 붙임
            let finalText = text || "[빈 응답]";
            if (thinkingText) {
                finalText = `<thinking>\n${thinkingText}\n</thinking>\n\n${text}`;
            }

            const openAIResponse = {
                choices: [{
                    message: { role: "assistant", content: finalText },
                    index: 0,
                    finish_reason: data.stop_reason === "end_turn" ? "stop" : (data.stop_reason || "stop"),
                }],
                model: data.model,
                usage: data.usage ? {
                    prompt_tokens: data.usage.input_tokens,
                    completion_tokens: data.usage.output_tokens,
                    total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
                } : undefined,
            };

            DebugLog.info(`Anthropic→OpenAI 변환 완료: 본문 ${text.length}자${thinkingText ? ` + 추론 ${thinkingText.length}자` : ""} → 최종 ${finalText.length}자`);

            return new Response(JSON.stringify(openAIResponse), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }
    },

    install() {
        if (this.active) return;
        this.originalFetch = window.fetch;
        const self = this;

        window.fetch = async function (...args) {
            const [url, options] = args;
            if (!getSettings().enabled) return self.originalFetch.apply(window, args);

            const urlStr = typeof url === "string" ? url : url?.url || "";
            const isTarget = urlStr.includes("/api/backends/chat-completions/generate") ||
                urlStr.includes("/api/backends/custom/generate");
            if (!isTarget) return self.originalFetch.apply(window, args);

            let requestBody;
            try {
                const bodyText = typeof options?.body === "string" ? options.body : await options?.body?.text?.() || "{}";
                requestBody = JSON.parse(bodyText);
            } catch { return self.originalFetch.apply(window, args); }

            if (!(requestBody.custom_url || "").includes("githubcopilot.com")) return self.originalFetch.apply(window, args);
            
            const token = getToken(requestBody);
            if (!token) { DebugLog.warn("토큰 없음 — API key 또는 GCM 필요"); return self.originalFetch.apply(window, args); }

            DebugLog.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            DebugLog.info("Copilot 요청 인터셉트!");

            try {
                return await self.interceptAndSend(requestBody);
            } catch (error) {
                DebugLog.error("인터셉트 실패:", String(error));
                toastr.error(`[CPI] ${error.message}`);
                return self.originalFetch.apply(window, args);
            }
        };

        this.active = true;
        DebugLog.info("인터셉터 설치 완료");
    },

    uninstall() {
        if (!this.active || !this.originalFetch) return;
        window.fetch = this.originalFetch;
        this.active = false;
        DebugLog.info("인터셉터 제거됨");
    },

    reset() {
        this.tidToken = "";
        this.tidTokenExpiry = 0;
        this.machineId = "";
        this.sessionId = "";
        DebugLog.info("세션/토큰 초기화됨");
    },
};

// ============================================================
// UI
// ============================================================
function updateStatus() {
    const s = getSettings();
    const el = $("#cpi_status");

    if (!s.enabled) {
        el.text("❌ 비활성").css("color", "#f44336");
    } else if (!hasAnyToken()) {
        el.text("⚠️ 토큰 없음 — API key 입력 또는 GCM 발급 필요").css("color", "#FF9800");
    } else if (Interceptor.active) {
        const labels = {
            "anthropic": "Anthropic (/v1/messages)",
            "anthropic-thinking": "Anthropic 추론 (/v1/messages)",
            "openai": "OpenAI (/chat/completions)",
            "passthrough": "패스스루 (/chat/completions)",
        };
        el.text(`✅ 활성 — ${labels[s.endpoint] || s.endpoint}`).css("color", "#4CAF50");
    } else {
        el.text("⚠️ 인터셉터 미설치").css("color", "#FF9800");
    }
}

// ============================================================
// 초기화
// ============================================================
jQuery(async () => {
    const html = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(html);

    // 이벤트
    $("#cpi_enabled").on("change", function () {
        const s = getSettings();
        s.enabled = $(this).prop("checked");
        saveSettings();
        s.enabled ? Interceptor.install() : Interceptor.uninstall();
        s.enabled ? toastr.success("[CPI] 활성화") : toastr.info("[CPI] 비활성화");
        updateStatus();
    });

    $("#cpi_endpoint").on("change", function () {
        const s = getSettings();
        s.endpoint = $(this).val();
        saveSettings();
        DebugLog.info("엔드포인트:", s.endpoint);
        $(".cpi-openai-only").toggle(s.endpoint === "openai");
        $(".cpi-thinking-only").toggle(s.endpoint === "anthropic-thinking");
        $(".cpi-passthrough-only").toggle(s.endpoint === "passthrough");
        updateStatus();
    });

    // adaptive thinking
    $("#cpi_adaptive_thinking").on("change", function () {
        const s = getSettings();
        s.adaptiveThinking = $(this).prop("checked");
        saveSettings();
        $(".cpi-budget-row").toggle(!s.adaptiveThinking);
        DebugLog.info("Adaptive Thinking:", s.adaptiveThinking ? "ON" : "OFF");
    });

    // thinking budget
    $("#cpi_thinking_budget").on("change", function () {
        const s = getSettings();
        s.thinkingBudget = parseInt($(this).val()) || 10000;
        saveSettings();
        DebugLog.info("추론 budget:", s.thinkingBudget);
    });

    $("#cpi_use_vscode_headers").on("change", function () {
        const s = getSettings(); s.useVscodeHeaders = $(this).prop("checked"); saveSettings();
    });
    $("#cpi_remove_prefill").on("change", function () {
        const s = getSettings(); s.removePrefill = $(this).prop("checked"); saveSettings();
        DebugLog.info("프리필 제거:", s.removePrefill ? "ON" : "OFF");
    });
    $("#cpi_trim_assistant").on("change", function () {
        const s = getSettings(); s.trimAssistant = $(this).prop("checked"); saveSettings();
        DebugLog.info("assistant trim:", s.trimAssistant ? "ON" : "OFF");
    });
    $("#cpi_force_last_user").on("change", function () {
        const s = getSettings(); s.forceLastUser = $(this).prop("checked"); saveSettings();
        DebugLog.info("마지막 user 강제:", s.forceLastUser ? "ON" : "OFF");
    });
    $("#cpi_basic_auth_compat").on("change", function () {
        const s = getSettings(); s.basicAuthCompat = $(this).prop("checked"); saveSettings();
        DebugLog.info("basicAuth:", s.basicAuthCompat ? "ON" : "OFF");
    });
    $("#cpi_debug_log").on("change", function () {
        const s = getSettings(); s.debugLog = $(this).prop("checked"); saveSettings();
        s.debugLog ? $("#cpi_log_panel").slideDown(150) && DebugLog.render() : $("#cpi_log_panel").slideUp(150);
    });
    $("#cpi_chat_version").on("change", function () {
        const s = getSettings(); s.chatVersion = $(this).val().trim() || "0.38.2026020704"; saveSettings(); Interceptor.reset();
    });
    $("#cpi_code_version").on("change", function () {
        const s = getSettings(); s.codeVersion = $(this).val().trim() || "1.109.0"; saveSettings(); Interceptor.reset();
    });
    $("#cpi_reset_session").on("click", () => { Interceptor.reset(); toastr.info("[CPI] 세션 초기화"); updateStatus(); });
    $("#cpi_clear_log").on("click", () => { DebugLog.clear(); toastr.info("[CPI] 로그 초기화"); });

    // 접기/펼치기 이벤트 위임
    $("#cpi_log_content").on("click", ".cpi-fold-btn", function () {
        const fold = $(this).closest(".cpi-fold");
        const action = $(this).data("action");
        if (action === "expand") {
            fold.find(".cpi-fold-short").hide();
            fold.find(".cpi-fold-long").show();
        } else {
            fold.find(".cpi-fold-long").hide();
            fold.find(".cpi-fold-short").show();
        }
    });

    // 맨 아래로 스크롤
    $("#cpi_scroll_bottom").on("click", () => {
        const el = $("#cpi_log_content");
        el.scrollTop(el[0]?.scrollHeight || 0);
    });

    // 모두 접기
    $("#cpi_fold_all").on("click", function () {
        const el = $("#cpi_log_content");
        const isAllFolded = el.find(".cpi-fold-long:visible").length === 0;
        if (isAllFolded) {
            // 모두 펼치기
            el.find(".cpi-fold-short").hide();
            el.find(".cpi-fold-long").show();
            $(this).val("📁 모두 접기");
        } else {
            // 모두 접기
            el.find(".cpi-fold-long").hide();
            el.find(".cpi-fold-short").show();
            $(this).val("📂 모두 펼치기");
        }
    });

    // 토큰 보관 시스템
    function renderTokenSelect() {
        const s = getSettings();
        const sel = $("#cpi_token_select");
        sel.empty();
        sel.append(`<option value="">-- 토큰 선택 (비어있으면 GCM 폴백) --</option>`);
        (s.tokens || []).forEach((t, i) => {
            const masked = t.value.substring(0, 8) + "...";
            sel.append(`<option value="${i}" ${s.token === t.value ? "selected" : ""}>${t.name} (${masked})</option>`);
        });
    }

    $("#cpi_token_select").on("change", function () {
        const s = getSettings();
        const idx = $(this).val();
        if (idx === "" || idx === null) {
            s.token = "";
        } else {
            s.token = s.tokens[parseInt(idx)]?.value || "";
        }
        saveSettings();
        updateStatus();
        DebugLog.info(s.token ? `토큰 선택: ${s.token.substring(0, 10)}...` : "토큰 해제 (GCM 폴백)");
    });

    $("#cpi_token_add").on("click", function () {
        const s = getSettings();
        const name = $("#cpi_token_name").val().trim();
        const value = $("#cpi_token_value").val().trim();
        if (!value) { toastr.warning("[CPI] 토큰을 입력하세요"); return; }
        if (!s.tokens) s.tokens = [];
        s.tokens.push({ name: name || `토큰 ${s.tokens.length + 1}`, value });
        s.token = value;
        saveSettings();
        renderTokenSelect();
        updateStatus();
        $("#cpi_token_name").val("");
        $("#cpi_token_value").val("");
        toastr.success(`[CPI] 토큰 추가: ${name || "토큰"}`);
        DebugLog.info(`토큰 추가: ${name} (${value.substring(0, 10)}...)`);
    });

    $("#cpi_token_delete").on("click", function () {
        const s = getSettings();
        const idx = $("#cpi_token_select").val();
        if (idx === "" || idx === null) { toastr.warning("[CPI] 삭제할 토큰을 선택하세요"); return; }
        const i = parseInt(idx);
        const removed = s.tokens.splice(i, 1)[0];
        if (s.token === removed.value) s.token = "";
        saveSettings();
        renderTokenSelect();
        updateStatus();
        toastr.info(`[CPI] 토큰 삭제: ${removed.name}`);
        DebugLog.info(`토큰 삭제: ${removed.name}`);
    });

    // 설정 로드
    const s = getSettings();
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }

    $("#cpi_enabled").prop("checked", s.enabled);
    $("#cpi_endpoint").val(s.endpoint);
    renderTokenSelect();
    $("#cpi_thinking_budget").val(s.thinkingBudget || 10000);
    $("#cpi_adaptive_thinking").prop("checked", !!s.adaptiveThinking);
    $(".cpi-budget-row").toggle(!s.adaptiveThinking);

    $("#cpi_use_vscode_headers").prop("checked", s.useVscodeHeaders);
    $("#cpi_remove_prefill").prop("checked", s.removePrefill);
    $("#cpi_trim_assistant").prop("checked", s.trimAssistant);
    $("#cpi_force_last_user").prop("checked", s.forceLastUser);
    $("#cpi_basic_auth_compat").prop("checked", s.basicAuthCompat);
    $("#cpi_debug_log").prop("checked", s.debugLog);
    $("#cpi_chat_version").val(s.chatVersion);
    $("#cpi_code_version").val(s.codeVersion);

    $(".cpi-openai-only").toggle(s.endpoint === "openai");
    $(".cpi-thinking-only").toggle(s.endpoint === "anthropic-thinking");
    $(".cpi-passthrough-only").toggle(s.endpoint === "passthrough");
    if (!s.debugLog) $("#cpi_log_panel").hide();

    if (s.enabled) Interceptor.install();
    updateStatus();
    DebugLog.info("CPI 로드 완료");
});
