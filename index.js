// CFA - Custom Format Adapter
// 연결 프로필의 custom 엔드포인트로 메시지 포맷만 변환해 전송
import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "CFA";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const defaultSettings = {
    enabled: true,
    removePrefill: true,
    trimAssistant: true,
    forceLastUser: true,
    basicAuthCompat: false,
    debugLog: true,
    endpoint: "anthropic",  // "openai", "anthropic", "anthropic-thinking", "passthrough", "responses"
    thinkingBudget: 10000,  // thinking budget_tokens
    adaptiveThinking: false, // adaptive thinking (Opus 4.6+)
    pathCorrection: false,   // 엔드포인트 경로 자동 보정 (custom_url 에 포맷별 경로 추가)

    token: "",  // 수동 입력 API key (선택, 비우면 연결 프로필 키 사용)
    tokens: [],  // 저장된 key 목록 [{name, value}]
};

const LOG_MAX = 200;

// ============================================================
// 디버그 로그
// ============================================================
const DebugLog = {
    entries: [],

    _renderTimer: null,

    add(level, ...args) {
        const s = getSettings();

        // 디버그 꺼져있으면 ERROR/WARN만 콘솔에 출력하고 끝
        if (!s.debugLog) {
            if (level === "ERROR") console.error(`[CFA] ${args.join(" ")}`);
            else if (level === "WARN") console.warn(`[CFA] ${args.join(" ")}`);
            return;
        }

        const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
        const msg = args.map(a =>
            typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)
        ).join(" ");

        this.entries.push({ time, level, msg });
        if (this.entries.length > LOG_MAX) this.entries.shift();

        if (level === "ERROR") console.error(`[CFA] ${msg}`);
        else if (level === "WARN") console.warn(`[CFA] ${msg}`);
        else console.log(`[CFA] ${msg}`);

        // 디바운스 렌더링 (200ms 내 중복 호출 방지)
        if (!this._renderTimer) {
            this._renderTimer = setTimeout(() => {
                this._renderTimer = null;
                this.render();
            }, 200);
        }
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

        // instructions / input (Responses 포맷)
        if (body?.instructions) {
            const instructionsText = typeof body.instructions === "string" ? body.instructions : JSON.stringify(body.instructions);
            this.add("REQ", `━━━ Instructions (${instructionsText.length}자) ━━━\n${instructionsText}`);
        }

        const inputItems = Array.isArray(body?.input) ? body.input : [];
        if (inputItems.length > 0) {
            this.add("REQ", `━━━ Input (${inputItems.length}개) ━━━`);
            inputItems.forEach((item, i) => {
                const c = extractTextFromMessageContent(item?.content, `request.input[${i}]`);
                this.add("REQ", `[${i}] role=${item?.role || "?"} (${c.length}자)\n${c}`);
            });
            this.add("REQ", `━━━ Input 끝 ━━━`);
        }
        const params = { ...body };
        delete params.messages;
        delete params.system;
        delete params.instructions;
        delete params.input;
        this.add("REQ", `기타: ${JSON.stringify(params)}`);
    },

    response(status, statusText, bodyPreview) {
        this.add("RES", `━━━ 응답 ━━━`);
        this.add("RES", `상태: ${status} ${statusText || ""}`);
        if (bodyPreview) {
            this.add("RES", `내용: ${bodyPreview.substring(0, 300)}${bodyPreview.length > 300 ? "..." : ""}`);
        }
    },

    _lastRenderedCount: 0,

    _buildEntry(e, idx) {
        const colors = { INFO: "#8bc34a", WARN: "#FF9800", ERROR: "#f44336", REQ: "#64b5f6", RES: "#ce93d8" };
        const FOLD_THRESHOLD = 200;
        const c = colors[e.level] || "#ccc";
        const escaped = escapeHtmlBr(e.msg);
        const header = `<span style="color:#666;">[${e.time}]</span> <span style="color:${c};font-weight:bold;">[${e.level}]</span> `;
        if (e.msg.length > FOLD_THRESHOLD) {
            const preview = escapeHtmlBr(e.msg.substring(0, FOLD_THRESHOLD));
            return `<div style="margin:1px 0;">${header}<span class="cfa-fold" data-idx="${idx}"><span class="cfa-fold-short" style="color:#ddd;">${preview}<span class="cfa-fold-btn" data-action="expand" style="color:#64b5f6;cursor:pointer;margin-left:4px;">▼ 펼치기</span></span><span class="cfa-fold-long" style="display:none;color:#ddd;">${escaped}<br><span class="cfa-fold-btn" data-action="collapse" style="color:#64b5f6;cursor:pointer;">▲ 접기</span></span></span></div>`;
        }
        return `<div style="margin:1px 0;">${header}<span style="color:#ddd;">${escaped}</span></div>`;
    },

    render() {
        const el = $("#cfa_log_content");
        if (!el.length) return;

        // LOG_MAX으로 shift 됐거나 clear 됐으면 전체 다시 그림
        if (this.entries.length < this._lastRenderedCount) {
            el.html(this.entries.map((e, i) => this._buildEntry(e, i)).join(""));
            this._lastRenderedCount = this.entries.length;
        } else if (this.entries.length > this._lastRenderedCount) {
            // 새로 추가된 것만 append
            const newHtml = this.entries
                .slice(this._lastRenderedCount)
                .map((e, i) => this._buildEntry(e, this._lastRenderedCount + i))
                .join("");
            el[0].insertAdjacentHTML("beforeend", newHtml);
            this._lastRenderedCount = this.entries.length;
        }

        requestAnimationFrame(() => {
            el.scrollTop(el[0]?.scrollHeight || 0);
        });
    },

    clear() { this.entries = []; this._lastRenderedCount = 0; $("#cfa_log_content").html(""); },
};

function escapeHtmlBr(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

// ============================================================
// 유틸
// ============================================================
/** 토큰: SillyTavern 연결 프로필의 API key에서 읽기 */
let _cachedApiKey = "";

function getToken(requestBody) {
    // 0. CFA 설정에 직접 입력한 키 (최우선)
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
    }
    // 3. 캐시된 토큰
    if (_cachedApiKey) return _cachedApiKey;
    return "";
}

function hasAnyToken() {
    const s = getSettings();
    return !!(s.token?.trim() || _cachedApiKey);
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
// Responses 어댑터 유틸
// ST(OpenAI-style) 요청/응답을 Responses 포맷으로 변환
// ============================================================
function buildTargetUrl(endpoint, customUrl) {
    const raw = (customUrl || "").trim();
    // 보정 OFF: 연결 프로필의 custom_url 을 그대로 사용 (무조건 custom)
    if (!getSettings().pathCorrection) return raw;

    // 보정 ON: 포맷에 맞는 경로를 자동으로 덧붙임 (이미 있으면 그대로)
    const base = raw.replace(/\/+$/, "");
    let path;
    if (endpoint === "anthropic" || endpoint === "anthropic-thinking") path = "/v1/messages";
    else if (endpoint === "responses") path = "/responses";
    else path = "/chat/completions";
    return base.endsWith(path) ? base : base + path;
}

function previewText(text, max = 160) {
    if (!text) return "";
    const compact = String(text).replace(/\s+/g, " ").trim();
    return compact.length > max ? `${compact.substring(0, max)}...` : compact;
}

function extractTextFromMessageContent(content, context = "message") {
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
        let text = "";
        content.forEach((part, index) => {
            if (typeof part === "string") {
                text += part;
                return;
            }
            if (!part || typeof part !== "object") {
                DebugLog.warn(`${context}[${index}] 알 수 없는 content part`);
                return;
            }
            if (typeof part.text === "string") {
                text += part.text;
                return;
            }
            if (typeof part.content === "string") {
                text += part.content;
                return;
            }
            DebugLog.warn(`${context}[${index}] 미지원 part type: ${part.type || "unknown"}`);
        });
        return text;
    }

    if (content && typeof content === "object") {
        if (typeof content.text === "string") return content.text;
        if (typeof content.content === "string") return content.content;
        DebugLog.warn(`${context} 알 수 없는 object content`);
    }

    return "";
}

function buildResponsesReasoningConfig(requestBody) {
    const existing = requestBody?.reasoning && typeof requestBody.reasoning === "object"
        ? requestBody.reasoning
        : {};
    const reasoning = {};

    const effort = existing.effort ?? requestBody?.reasoning_effort;
    if (effort != null) {
        reasoning.effort = effort;
    }

    const summary = existing.summary ?? (requestBody?.include_reasoning ? "auto" : undefined);
    if (summary != null && summary !== false) {
        reasoning.summary = summary;
    }

    return Object.keys(reasoning).length > 0 ? reasoning : null;
}

function convertToResponsesFormat(requestBody) {
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
    const instructions = [];
    const input = [];

    messages.forEach((message, index) => {
        if (!message || typeof message !== "object") {
            DebugLog.warn(`responses.messages[${index}] 잘못된 message 형식`);
            return;
        }

        const role = message.role || "user";
        const content = extractTextFromMessageContent(message.content, `responses.messages[${index}]`);
        if (!content.trim()) {
            return;
        }

        if (role === "system" || role === "developer") {
            instructions.push(content.trim());
            return;
        }

        if (role !== "user" && role !== "assistant") {
            DebugLog.warn(`responses.messages[${index}] 미지원 role: ${role}`);
            return;
        }

        // 연속 같은 role 병합 (Anthropic 변환과 동일한 패턴)
        const last = input.length > 0 ? input[input.length - 1] : null;
        if (last && last.role === role) {
            last.content += "\n\n" + content;
        } else {
            input.push({ role, content });
        }
    });

    if (input.length === 0) {
        input.push({ role: "user", content: "Continue" });
    } else if (input[input.length - 1].role !== "user") {
        input.push({ role: "user", content: "Continue" });
    }

    const body = {
        model: requestBody?.model || "gpt-4.1",
        input,
    };

    if (instructions.length > 0) {
        body.instructions = instructions.join("\n\n");
    }
    if (requestBody?.stream != null) body.stream = requestBody.stream;
    if (requestBody?.temperature != null) body.temperature = requestBody.temperature;
    if (requestBody?.top_p != null) body.top_p = requestBody.top_p;

    if (requestBody?.max_tokens != null) {
        body.max_output_tokens = requestBody.max_tokens;
    } else if (requestBody?.max_output_tokens != null) {
        body.max_output_tokens = requestBody.max_output_tokens;
    }

    const reasoning = buildResponsesReasoningConfig(requestBody);
    if (reasoning) {
        body.reasoning = reasoning;
    }

    if (requestBody?.store != null) body.store = requestBody.store;
    if (requestBody?.metadata != null) body.metadata = requestBody.metadata;
    if (requestBody?.user != null) body.user = requestBody.user;
    if (requestBody?.text != null) body.text = requestBody.text;
    if (requestBody?.stream_options != null) body.stream_options = requestBody.stream_options;

    if (requestBody?.response_format != null) {
        DebugLog.warn("Responses 변환: response_format은 직접 매핑되지 않아 무시됨");
    }
    if (requestBody?.tools != null || requestBody?.tool_choice != null) {
        DebugLog.warn("Responses 변환: tool 관련 필드는 직접 매핑되지 않아 무시됨");
    }

    return body;
}

function extractResponsesTextFromPart(part) {
    if (!part || typeof part !== "object") return "";
    if ((part.type === "output_text" || part.type === "text" || part.type === "summary_text" || part.type === "reasoning_text") && typeof part.text === "string") {
        return part.text;
    }
    if (part.type === "refusal" && typeof part.refusal === "string") {
        return part.refusal;
    }
    return "";
}

function extractResponsesReasoningTextFromItem(item) {
    if (!item || typeof item !== "object") return "";

    if (Array.isArray(item.summary) && item.summary.length > 0) {
        return item.summary.map(extractResponsesTextFromPart).join("");
    }

    if (Array.isArray(item.content) && item.content.length > 0) {
        return item.content.map(extractResponsesTextFromPart).join("");
    }

    return "";
}

function extractResponsesOutputText(apiResponse) {
    if (typeof apiResponse?.output_text === "string") {
        return apiResponse.output_text;
    }

    if (Array.isArray(apiResponse?.output_text)) {
        return apiResponse.output_text.map(extractResponsesTextFromPart).join("");
    }

    const output = Array.isArray(apiResponse?.output) ? apiResponse.output : [];
    const segments = [];

    output.forEach((item) => {
        if (!item || typeof item !== "object") return;

        if (item.type === "message" && item.role === "assistant") {
            segments.push((Array.isArray(item.content) ? item.content : []).map(extractResponsesTextFromPart).join(""));
            return;
        }

        if (item.type === "output_text") {
            segments.push(extractResponsesTextFromPart(item));
        }
    });

    return segments.join("");
}

function extractResponsesReasoningText(apiResponse) {
    const output = Array.isArray(apiResponse?.output) ? apiResponse.output : [];
    const segments = [];

    output.forEach((item) => {
        if (!item || typeof item !== "object") return;
        if (item.type === "reasoning") {
            const text = extractResponsesReasoningTextFromItem(item);
            if (text) segments.push(text);
        }
    });

    return segments.join("\n\n");
}

function formatThinkingContent(reasoningText, responseText) {
    const finalText = responseText || "";
    if (!reasoningText) return finalText;
    return finalText
        ? `<thinking>\n${reasoningText}\n</thinking>\n\n${finalText}`
        : `<thinking>\n${reasoningText}\n</thinking>`;
}

function mapResponsesFinishReason(apiResponse) {
    const reason = apiResponse?.incomplete_details?.reason || apiResponse?.reason;
    if (reason === "max_output_tokens" || reason === "max_tokens") {
        return "length";
    }
    return "stop";
}

function convertResponsesToOpenAIResponse(apiResponse, options = {}) {
    const responseText = extractResponsesOutputText(apiResponse);
    const reasoningText = extractResponsesReasoningText(apiResponse);

    if (!responseText && !reasoningText) {
        DebugLog.warn("Responses 응답에서 assistant 텍스트를 찾지 못함");
    }

    const finalText = formatThinkingContent(reasoningText, responseText);
    const usage = apiResponse?.usage ? {
        prompt_tokens: apiResponse.usage.input_tokens,
        completion_tokens: apiResponse.usage.output_tokens,
        total_tokens: apiResponse.usage.total_tokens
            ?? ((apiResponse.usage.input_tokens || 0) + (apiResponse.usage.output_tokens || 0)),
    } : undefined;

    return {
        id: apiResponse?.id || options.id || `resp-${Date.now()}`,
        object: "chat.completion",
        created: apiResponse?.created_at || options.created || Math.floor(Date.now() / 1000),
        model: apiResponse?.model || options.model,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: finalText,
            },
            finish_reason: mapResponsesFinishReason(apiResponse),
        }],
        usage,
    };
}

function normalizeResponsesError(error, responseText, status) {
    let message = error?.message || `${status || 500} Responses 응답 오류`;

    if (responseText) {
        try {
            const parsed = JSON.parse(responseText);
            message = parsed.error?.message || parsed.message || message;
        } catch {
            message = responseText;
        }
    }

    return {
        error: {
            message: `Responses API 요청 실패: ${message}`,
            type: "responses_error",
            code: status,
        },
    };
}

// ============================================================
// 인터셉터
// ============================================================
const Interceptor = {
    originalFetch: null,
    active: false,

    async interceptAndSend(requestBody) {
        const token = getToken(requestBody);
        if (!token) throw new Error("토큰 없음 — 연결 프로필 API key 필요");

        const s = getSettings();
        const customUrl = (requestBody.custom_url || "").trim();
        if (!customUrl) throw new Error("custom_url 없음 — 연결 프로필 엔드포인트 필요");

        const isAnthropic = s.endpoint === "anthropic" || s.endpoint === "anthropic-thinking";
        const isThinking = s.endpoint === "anthropic-thinking";
        const isResponses = s.endpoint === "responses";
        const isPassthrough = s.endpoint === "passthrough";
        const url = buildTargetUrl(s.endpoint, customUrl);

        DebugLog.info(`엔드포인트: ${s.endpoint}${isThinking ? " (추론)" : ""} → ${url}`);
        DebugLog.info(`경로 보정: ${s.pathCorrection ? "ON" : "OFF (custom_url 그대로)"}`);

        const headers = { "Content-Type": "application/json" };
        if (isAnthropic) {
            headers["Accept"] = "application/json";
        } else {
            headers["Accept"] = requestBody.stream ? "text/event-stream" : "application/json";
        }
        headers["Authorization"] = `Bearer ${token}`;

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

            // logprobs: 숫자 → boolean 변환 (일부 API는 boolean만 허용)
            if (body.logprobs != null && typeof body.logprobs !== "boolean") {
                body.logprobs = !!body.logprobs;
                DebugLog.info("logprobs 타입 변환: number → boolean");
            }

            // 빈 content 메시지 제거
            if (Array.isArray(body.messages)) {
                body.messages = body.messages.filter((m) => {
                    const c = typeof m.content === "string" ? m.content.trim()
                        : Array.isArray(m.content) ? m.content.map(b => b.text || "").join("").trim()
                        : "";
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
                DebugLog.warn("top_p 제거 (temperature와 동시 사용 불가)");
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
            // Responses도 ST의 OpenAI-style 입력을 받은 뒤 2차 어댑터 변환이 필요
            if (body.temperature != null && body.top_p != null) {
                DebugLog.warn("top_p 제거 (temperature와 동시 사용 불가)");
                delete body.top_p;
            }

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

            if (!isResponses) {
                delete body.include_reasoning;
                delete body.reasoning_effort;
                delete body.reasoning;
            }

            if (s.removePrefill && body.messages?.length > 0) {
                let removed = 0;
                while (body.messages.length > 1 && body.messages[body.messages.length - 1].role === "assistant") {
                    const removedMessage = body.messages.pop();
                    DebugLog.warn(`프리필 제거: [${removedMessage.role}]`);
                    removed++;
                }
                if (removed > 0) DebugLog.info(`${removed}개 프리필 제거됨`);
            }

            if (s.trimAssistant && body.messages?.length > 0) {
                for (const message of body.messages) {
                    if (message.role === "assistant" && typeof message.content === "string") {
                        const original = message.content;
                        message.content = message.content.trimEnd();
                        if (original !== message.content) {
                            DebugLog.warn(`assistant 끝 공백 제거 (${original.length} → ${message.content.length}자)`);
                        }
                    }
                }
            }

            if (s.forceLastUser && body.messages?.length > 0) {
                const last = body.messages[body.messages.length - 1];
                if (last.role !== "user") {
                    DebugLog.warn(`마지막 role 변환: ${last.role} → user`);
                    last.role = "user";
                }
            }

            // logprobs: 숫자 → boolean 변환 (일부 API는 boolean만 허용)
            if (body.logprobs != null && typeof body.logprobs !== "boolean") {
                body.logprobs = !!body.logprobs;
                DebugLog.info("logprobs 타입 변환: number → boolean");
            }

            if (isResponses) {
                DebugLog.info("OpenAI → Responses 포맷 변환 중...");
                body = convertToResponsesFormat(body);
                DebugLog.info(`변환 완료: instructions ${body.instructions ? "있음" : "없음"}, input ${body.input.length}개${body.reasoning ? ", reasoning ON" : ""}`);
            }
        }

        // 디버그 로그
        DebugLog.request("POST", url, headers, body);

        // ━━━ 요청 body 핵심 파라미터 디버그 ━━━
        DebugLog.info(`━━━ 요청 분석 ━━━`);
        DebugLog.info(`  모드: ${s.endpoint}`);
        DebugLog.info(`  URL: ${url}`);
        DebugLog.info(`  모델: ${body.model || "(없음)"}`);
        DebugLog.info(`  stream: ${body.stream ?? false}`);
        DebugLog.info(`  temperature: ${body.temperature ?? "(없음)"}`);

        if (isPassthrough) {
            DebugLog.info(`  패스스루 body 키: [${Object.keys(body).join(", ")}]`);
        } else if (isResponses) {
            const instructionsText = typeof body.instructions === "string" ? body.instructions : "";
            const totalInputLen = Array.isArray(body.input)
                ? body.input.reduce((sum, item) => sum + extractTextFromMessageContent(item?.content).length, 0)
                : 0;
            const inputPreview = Array.isArray(body.input)
                ? previewText(body.input.map((item) => `[${item.role}] ${extractTextFromMessageContent(item?.content)}`).join("\n"))
                : "";

            DebugLog.info(`  instructions 길이: ${instructionsText.length}자`);
            DebugLog.info(`  instructions preview: ${previewText(instructionsText) || "(없음)"}`);
            DebugLog.info(`  input: ${body.input?.length || 0}개`);
            DebugLog.info(`  input 총 길이: ${totalInputLen}자`);
            DebugLog.info(`  input preview: ${inputPreview || "(없음)"}`);
            DebugLog.info(`  max_output_tokens: ${body.max_output_tokens ?? "(없음)"}`);
            DebugLog.info(`  reasoning: ${body.reasoning ? JSON.stringify(body.reasoning) : "❌ 없음"}`);
        } else {
            DebugLog.info(`  thinking 필드: ${body.thinking ? JSON.stringify(body.thinking) : "❌ 없음"}`);
            DebugLog.info(`  max_tokens: ${body.max_tokens}`);
            DebugLog.info(`  messages: ${body.messages?.length || 0}개`);
            if (body.system) {
                const sysLen = Array.isArray(body.system)
                    ? body.system.map((item) => item.text?.length || 0).reduce((a, b) => a + b, 0)
                    : (typeof body.system === "string" ? body.system.length : 0);
                DebugLog.info(`  system 길이: ${sysLen}자`);
            }
            const totalMsgLen = (body.messages || []).reduce((sum, message) => {
                if (typeof message.content === "string") return sum + message.content.length;
                if (Array.isArray(message.content)) return sum + message.content.reduce((acc, part) => acc + (part.text?.length || 0), 0);
                return sum;
            }, 0);
            DebugLog.info(`  메시지 총 길이: ${totalMsgLen}자`);
        }
        DebugLog.info(`━━━━━━━━━━━━━━━`);

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

            if (isResponses) {
                return new Response(JSON.stringify(normalizeResponsesError(new Error(response.statusText), errText, response.status)), {
                    status: response.status,
                    headers: { "Content-Type": "application/json" },
                });
            }
        } else {
            DebugLog.response(response.status, response.statusText, "(응답 수신)");
            DebugLog.info(`✅ 요청 성공 (${elapsed}ms)`);
            DebugLog.info(`  ⏱️ 네트워크 소요: ${elapsed}ms (${(elapsed / 1000).toFixed(1)}초)`);
            const respHeaders = {};
            response.headers.forEach((v, k) => { respHeaders[k] = v; });
            DebugLog.info(`  응답 헤더: ${JSON.stringify(respHeaders)}`);
        }

        if (isAnthropic && response.ok) {
            try {
                return await this.convertAnthropicResponse(response, body.stream);
            } catch (e) {
                DebugLog.error("Anthropic 응답 변환 실패:", String(e));
                return new Response(JSON.stringify({
                    choices: [{ message: { role: "assistant", content: `[CFA] 응답 변환 오류: ${e.message}` }, index: 0, finish_reason: "stop" }],
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
        }

        if (isResponses && response.ok) {
            try {
                return await this.handleResponsesResponse(response, {
                    stream: !!body.stream,
                    model: body.model,
                });
            } catch (e) {
                DebugLog.error("Responses 응답 변환 실패:", String(e));
                return new Response(JSON.stringify(normalizeResponsesError(e, null, 500)), {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                });
            }
        }

        // ━━━ passthrough/openai: 비스트리밍일 때 clone으로 응답 로그 ━━━
        if (response.ok && !body.stream && getSettings().debugLog) {
            try {
                const cloned = response.clone();
                cloned.json().then(data => {
                    const content = data.choices?.[0]?.message?.content || "";
                    const model = data.model || "(없음)";
                    const usage = data.usage;
                    DebugLog.info(`━━━ 패스스루 응답 ━━━`);
                    DebugLog.info(`  모델: ${model}`);
                    if (usage) {
                        DebugLog.info(`  prompt_tokens: ${usage.prompt_tokens || 0}`);
                        DebugLog.info(`  completion_tokens: ${usage.completion_tokens || 0}`);
                    }
                    DebugLog.info(`  본문 길이: ${content.length}자`);
                    DebugLog.add("RES", `━━━ 응답 본문 ━━━\n${content}\n━━━ 응답 끝 ━━━`);
                }).catch(() => {});
            } catch {}
        }

        return response;
    },

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
            let doneSent = false;

            const logAnthropicSummary = () => {
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
            };

            const finalizeAnthropic = (controller) => {
                if (doneSent) return;
                doneSent = true;
                if (inThinking) {
                    const tag = { choices: [{ delta: { content: "\n</thinking>\n\n" }, index: 0 }] };
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tag)}\n\n`));
                    inThinking = false;
                }
                controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                logAnthropicSummary();
                controller.close();
            };

            const stream = new ReadableStream({
                async pull(controller) {
                    try {
                    const { done, value } = await reader.read();
                    if (done) {
                        finalizeAnthropic(controller);
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
                                finalizeAnthropic(controller);
                                return;
                            }
                            // 스트림 중 에러
                            else if (event.type === "error") {
                                const errMsg = event.error?.message || "Unknown error";
                                DebugLog.error(`[스트림] 에러 이벤트: ${errMsg}`);
                                const errChunk = { choices: [{ delta: { content: `\n[Error: ${errMsg}]\n` }, index: 0 }] };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errChunk)}\n\n`));
                                finalizeAnthropic(controller);
                                return;
                            }
                        } catch { /* skip malformed JSON */ }
                    }
                    } catch (e) {
                        DebugLog.error("스트림 읽기 실패:", String(e));
                        try {
                            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                            controller.close();
                        } catch { /* already closed */ }
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
                    choices: [{ message: { role: "assistant", content: "[CFA] 응답 파싱 실패" }, index: 0, finish_reason: "stop" }],
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



    async handleResponsesResponse(response, options = {}) {
        // Responses는 요청/응답/스트림 스키마가 달라서 ST용 OpenAI 계약으로 다시 감싼다.
        DebugLog.info(`[Responses 핸들러] stream=${options.stream}, model=${options.model}`);
        if (options.stream) {
            return this.pipeResponsesStreamAsOpenAI(response, options);
        }

        const responseText = await response.text();
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (error) {
            DebugLog.error("Responses 응답 JSON 파싱 실패:", String(error));
            return new Response(JSON.stringify(normalizeResponsesError(error, responseText, 502)), {
                status: 502,
                headers: { "Content-Type": "application/json" },
            });
        }

        const assistantText = extractResponsesOutputText(data);
        const reasoningText = extractResponsesReasoningText(data);
        DebugLog.info(`━━━ Responses 응답 분석 ━━━`);
        DebugLog.info(`  모델: ${data.model || "(없음)"}`);
        DebugLog.info(`  status: ${data.status || "(없음)"}`);
        DebugLog.info(`  finish_reason: ${mapResponsesFinishReason(data)}`);
        DebugLog.info(`  output items: ${Array.isArray(data.output) ? data.output.length : 0}개`);
        DebugLog.info(`  본문 길이: ${assistantText.length}자`);
        if (reasoningText) {
            DebugLog.info(`  추론 길이: ${reasoningText.length}자`);
            DebugLog.add("REQ", `━━━ Responses 추론 내용 ━━━\n${reasoningText}\n━━━ Responses 추론 끝 ━━━`);
        } else {
            DebugLog.info("  추론: ❌ 없음");
        }
        DebugLog.info(`━━━━━━━━━━━━━━━`);

        const openAIResponse = convertResponsesToOpenAIResponse(data, {
            id: options.id,
            model: options.model,
            created: options.created,
        });

        return new Response(JSON.stringify(openAIResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    },

    async pipeResponsesStreamAsOpenAI(response, options = {}) {
        DebugLog.info(`[Responses 스트림] 파이프 시작`);
        const reader = response.body?.getReader?.();
        if (!reader) {
            DebugLog.error("[Responses 스트림] reader 생성 실패");
            return new Response(JSON.stringify(normalizeResponsesError(new Error("Responses 스트림 body 없음"), null, 502)), {
                status: 502, headers: { "Content-Type": "application/json" },
            });
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let inThinking = false;
        let thinkingAccum = "";
        let textAccum = "";
        let streamStartTime = Date.now();
        let firstChunkTime = null;
        let doneSent = false;
        let sseEventType = "";

        const logSummary = () => {
            const elapsed = Date.now() - streamStartTime;
            const ttfb = firstChunkTime ? firstChunkTime - streamStartTime : 0;
            DebugLog.info(`━━━ Responses 스트리밍 완료 ━━━`);
            DebugLog.info(`  총 소요: ${elapsed}ms (${(elapsed / 1000).toFixed(1)}초)`);
            DebugLog.info(`  TTFB: ${ttfb}ms`);
            DebugLog.info(`  본문: ${textAccum.length}자`);
            if (thinkingAccum) {
                DebugLog.info(`  추론: ${thinkingAccum.length}자`);
                DebugLog.add("REQ", `━━━ Responses 추론 내용 ━━━\n${thinkingAccum}\n━━━ Responses 추론 끝 ━━━`);
            } else {
                DebugLog.info("  추론: ❌ 없음");
            }
            DebugLog.info("━━━━━━━━━━━━━━━");
        };

        const finalize = (controller) => {
            if (doneSent) return;
            doneSent = true;
            if (inThinking) {
                const tag = { choices: [{ delta: { content: "\n</thinking>\n\n" }, index: 0 }] };
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tag)}\n\n`));
                inThinking = false;
            }
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            logSummary();
            controller.close();
        };

        const stream = new ReadableStream({
            async pull(controller) {
                // 메타데이터 전용 청크에서 멈추지 않도록
                // 실제 content를 enqueue하거나 스트림이 끝날 때까지 계속 읽음
                while (true) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        finalize(controller);
                        return;
                    }

                    if (!firstChunkTime) firstChunkTime = Date.now();

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    let didEnqueue = false;

                    for (const line of lines) {
                        if (line.startsWith("event:")) {
                            sseEventType = line.slice(6).trim();
                            continue;
                        }
                        if (!line.startsWith("data:")) continue;
                        const dataStr = line.slice(5).trim();
                        if (!dataStr) continue;
                        if (dataStr === "[DONE]") {
                            finalize(controller);
                            return;
                        }

                        let event;
                        try { event = JSON.parse(dataStr); } catch { continue; }

                        const type = event.type || sseEventType;

                        // 텍스트 델타
                        if (type === "response.output_text.delta") {
                            const text = event.delta || "";
                            if (!text) continue;
                            if (inThinking) {
                                const tag = { choices: [{ delta: { content: "\n</thinking>\n\n" }, index: 0 }] };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tag)}\n\n`));
                                inThinking = false;
                            }
                            textAccum += text;
                            const chunk = { choices: [{ delta: { content: text }, index: 0 }] };
                            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                            didEnqueue = true;
                        }
                        // 추론 델타
                        else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
                            const text = event.delta || "";
                            if (!text) continue;
                            if (!inThinking) {
                                inThinking = true;
                                const tag = { choices: [{ delta: { content: "<thinking>\n" }, index: 0 }] };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(tag)}\n\n`));
                            }
                            thinkingAccum += text;
                            const chunk = { choices: [{ delta: { content: text }, index: 0 }] };
                            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                            didEnqueue = true;
                        }
                        // 거부 델타
                        else if (type === "response.refusal.delta") {
                            const text = event.delta || "";
                            if (text) {
                                textAccum += text;
                                const chunk = { choices: [{ delta: { content: text }, index: 0 }] };
                                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                                didEnqueue = true;
                            }
                        }
                        // 에러
                        else if (type === "response.failed" || type === "error") {
                            const errMsg = event.error?.message || event.message || "Unknown error";
                            DebugLog.error(`[Responses 스트림] ${errMsg}`);
                            const errChunk = { choices: [{ delta: { content: `\n[Error: ${errMsg}]\n` }, index: 0 }] };
                            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errChunk)}\n\n`));
                            finalize(controller);
                            return;
                        }
                        // 스트림 종료
                        else if (type === "response.completed" || type === "response.incomplete") {
                            finalize(controller);
                            return;
                        }
                        // 나머지 (메타데이터 등): 무시
                    }

                    if (didEnqueue) return; // 콘텐츠 전달 완료 → pull 종료
                    // 콘텐츠 없는 메타데이터 청크 → while 루프로 다음 청크 읽기
                } catch (e) {
                    DebugLog.error("Responses 스트림 읽기 실패:", String(e));
                    try {
                        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                        controller.close();
                    } catch { /* already closed */ }
                    return;
                }
                } // while
            },
        });

        return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
        });
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

            // 전체 on/off: custom_url 이 있으면 처리 (연결 프로필 엔드포인트로 전송)
            if (!(requestBody.custom_url || "").trim()) return self.originalFetch.apply(window, args);

            const token = getToken(requestBody);
            if (!token) { DebugLog.warn("토큰 없음 — 연결 프로필 API key 필요"); return self.originalFetch.apply(window, args); }

            DebugLog.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            DebugLog.info("요청 인터셉트!");

            try {
                return await self.interceptAndSend(requestBody);
            } catch (error) {
                DebugLog.error("인터셉트 실패:", String(error));
                toastr.error(`[CFA] ${error.message}`);
                try {
                    return await self.originalFetch.apply(window, args);
                } catch {
                    return new Response(JSON.stringify({ error: { message: error.message } }), {
                        status: 500, headers: { "Content-Type": "application/json" }
                    });
                }
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
};

// ============================================================
// UI
// ============================================================
function updateStatus() {
    const s = getSettings();
    const el = $("#cfa_status");

    if (!s.enabled) {
        el.text("❌ 비활성").css("color", "#f44336");
    } else if (!hasAnyToken()) {
        el.text("⚠️ 토큰 없음 — 연결 프로필 API key 입력 필요").css("color", "#FF9800");
    } else if (Interceptor.active) {
        const labels = {
            "anthropic": "Anthropic 포맷",
            "anthropic-thinking": "Anthropic 추론 포맷",
            "openai": "OpenAI 포맷",
            "passthrough": "패스스루 (변환 없음)",
            "responses": "Responses 포맷",
        };
        const corr = s.pathCorrection ? " · 경로보정 ON" : "";
        el.text(`✅ 활성 — ${labels[s.endpoint] || s.endpoint}${corr}`).css("color", "#4CAF50");
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
    $("#cfa_enabled").on("change", function () {
        const s = getSettings();
        s.enabled = $(this).prop("checked");
        saveSettings();
        s.enabled ? Interceptor.install() : Interceptor.uninstall();
        s.enabled ? toastr.success("[CFA] 활성화") : toastr.info("[CFA] 비활성화");
        updateStatus();
    });

    $("#cfa_endpoint").on("change", function () {
        const s = getSettings();
        s.endpoint = $(this).val();
        saveSettings();
        DebugLog.info("엔드포인트:", s.endpoint);
        $(".cfa-openai-only").toggle(s.endpoint === "openai" || s.endpoint === "responses");
        $(".cfa-thinking-only").toggle(s.endpoint === "anthropic-thinking");
        $(".cfa-passthrough-only").toggle(s.endpoint === "passthrough");
        updateStatus();
    });

    // adaptive thinking
    $("#cfa_adaptive_thinking").on("change", function () {
        const s = getSettings();
        s.adaptiveThinking = $(this).prop("checked");
        saveSettings();
        $(".cfa-budget-row").toggle(!s.adaptiveThinking);
        DebugLog.info("Adaptive Thinking:", s.adaptiveThinking ? "ON" : "OFF");
    });

    // thinking budget
    $("#cfa_thinking_budget").on("change", function () {
        const s = getSettings();
        s.thinkingBudget = parseInt($(this).val()) || 10000;
        saveSettings();
        DebugLog.info("추론 budget:", s.thinkingBudget);
    });

    $("#cfa_path_correction").on("change", function () {
        const s = getSettings(); s.pathCorrection = $(this).prop("checked"); saveSettings();
        DebugLog.info("경로 보정:", s.pathCorrection ? "ON" : "OFF");
    });
    $("#cfa_remove_prefill").on("change", function () {
        const s = getSettings(); s.removePrefill = $(this).prop("checked"); saveSettings();
        DebugLog.info("프리필 제거:", s.removePrefill ? "ON" : "OFF");
    });
    $("#cfa_trim_assistant").on("change", function () {
        const s = getSettings(); s.trimAssistant = $(this).prop("checked"); saveSettings();
        DebugLog.info("assistant trim:", s.trimAssistant ? "ON" : "OFF");
    });
    $("#cfa_force_last_user").on("change", function () {
        const s = getSettings(); s.forceLastUser = $(this).prop("checked"); saveSettings();
        DebugLog.info("마지막 user 강제:", s.forceLastUser ? "ON" : "OFF");
    });
    $("#cfa_basic_auth_compat").on("change", function () {
        const s = getSettings(); s.basicAuthCompat = $(this).prop("checked"); saveSettings();
        DebugLog.info("basicAuth:", s.basicAuthCompat ? "ON" : "OFF");
    });
    $("#cfa_debug_log").on("change", function () {
        const s = getSettings(); s.debugLog = $(this).prop("checked"); saveSettings();
        s.debugLog ? $("#cfa_log_panel").slideDown(150) && DebugLog.render() : $("#cfa_log_panel").slideUp(150);
    });
    $("#cfa_clear_log").on("click", () => { DebugLog.clear(); toastr.info("[CFA] 로그 초기화"); });

    // 접기/펼치기 이벤트 위임
    $("#cfa_log_content").on("click", ".cfa-fold-btn", function () {
        const fold = $(this).closest(".cfa-fold");
        const action = $(this).data("action");
        if (action === "expand") {
            fold.find(".cfa-fold-short").hide();
            fold.find(".cfa-fold-long").show();
        } else {
            fold.find(".cfa-fold-long").hide();
            fold.find(".cfa-fold-short").show();
        }
    });

    // 맨 아래로 스크롤
    $("#cfa_scroll_bottom").on("click", () => {
        const el = $("#cfa_log_content");
        el.scrollTop(el[0]?.scrollHeight || 0);
    });

    // 모두 접기
    $("#cfa_fold_all").on("click", function () {
        const el = $("#cfa_log_content");
        const isAllFolded = el.find(".cfa-fold-long:visible").length === 0;
        if (isAllFolded) {
            // 모두 펼치기
            el.find(".cfa-fold-short").hide();
            el.find(".cfa-fold-long").show();
            $(this).val("📁 모두 접기");
        } else {
            // 모두 접기
            el.find(".cfa-fold-long").hide();
            el.find(".cfa-fold-short").show();
            $(this).val("📂 모두 펼치기");
        }
    });

    // 토큰 보관 시스템
    function renderTokenSelect() {
        const s = getSettings();
        const sel = $("#cfa_token_select");
        sel.empty();
        sel.append(`<option value="">-- 키 선택 (비우면 연결 프로필 키 사용) --</option>`);
        (s.tokens || []).forEach((t, i) => {
            const masked = t.value.substring(0, 8) + "...";
            sel.append(`<option value="${i}" ${s.token === t.value ? "selected" : ""}>${t.name} (${masked})</option>`);
        });
    }

    $("#cfa_token_select").on("change", function () {
        const s = getSettings();
        const idx = $(this).val();
        if (idx === "" || idx === null) {
            s.token = "";
        } else {
            s.token = s.tokens[parseInt(idx)]?.value || "";
        }
        saveSettings();
        updateStatus();
        DebugLog.info(s.token ? `키 선택: ${s.token.substring(0, 10)}...` : "키 해제 (연결 프로필 키 사용)");
    });

    $("#cfa_token_add").on("click", function () {
        const s = getSettings();
        const name = $("#cfa_token_name").val().trim();
        const value = $("#cfa_token_value").val().trim();
        if (!value) { toastr.warning("[CFA] 토큰을 입력하세요"); return; }
        if (!s.tokens) s.tokens = [];
        s.tokens.push({ name: name || `토큰 ${s.tokens.length + 1}`, value });
        s.token = value;
        saveSettings();
        renderTokenSelect();
        updateStatus();
        $("#cfa_token_name").val("");
        $("#cfa_token_value").val("");
        toastr.success(`[CFA] 토큰 추가: ${name || "토큰"}`);
        DebugLog.info(`토큰 추가: ${name} (${value.substring(0, 10)}...)`);
    });

    $("#cfa_token_delete").on("click", function () {
        const s = getSettings();
        const idx = $("#cfa_token_select").val();
        if (idx === "" || idx === null) { toastr.warning("[CFA] 삭제할 토큰을 선택하세요"); return; }
        const i = parseInt(idx);
        const removed = s.tokens.splice(i, 1)[0];
        if (s.token === removed.value) s.token = "";
        saveSettings();
        renderTokenSelect();
        updateStatus();
        toastr.info(`[CFA] 토큰 삭제: ${removed.name}`);
        DebugLog.info(`토큰 삭제: ${removed.name}`);
    });

    // 설정 로드
    const s = getSettings();
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }

    $("#cfa_enabled").prop("checked", s.enabled);
    $("#cfa_endpoint").val(s.endpoint);
    renderTokenSelect();
    $("#cfa_thinking_budget").val(s.thinkingBudget || 10000);
    $("#cfa_adaptive_thinking").prop("checked", !!s.adaptiveThinking);
    $(".cfa-budget-row").toggle(!s.adaptiveThinking);

    $("#cfa_remove_prefill").prop("checked", s.removePrefill);
    $("#cfa_trim_assistant").prop("checked", s.trimAssistant);
    $("#cfa_force_last_user").prop("checked", s.forceLastUser);
    $("#cfa_basic_auth_compat").prop("checked", s.basicAuthCompat);
    $("#cfa_debug_log").prop("checked", s.debugLog);
    $("#cfa_path_correction").prop("checked", s.pathCorrection);

    $(".cfa-openai-only").toggle(s.endpoint === "openai" || s.endpoint === "responses");
    $(".cfa-thinking-only").toggle(s.endpoint === "anthropic-thinking");
    $(".cfa-passthrough-only").toggle(s.endpoint === "passthrough");
    if (!s.debugLog) $("#cfa_log_panel").hide();

    if (s.enabled) Interceptor.install();
    updateStatus();
    DebugLog.info("CFA 로드 완료");
});
