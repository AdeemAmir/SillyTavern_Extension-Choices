import {
    eventSource,
    event_types,
    generateQuietPrompt,
    getRequestHeaders
} from '../../../../script.js';

import { getContext } from '../../../extensions.js';

(function () {
    const MODULE_NAME = "SillyTavern_Extension-Choices";
    const MODULE_VERSION = "2.3.0"; // Version updated
    const API_BASE = "/api/plugins/sillytavern_extension-choices"; 
    
    // --- V2.3.0 DEFAULT PROMPTS & MATRIX ---
    const defaultPrompts = {
        instructionPrompt: `[CHOICE GENERATOR]

Analyze the story through its CURRENT END and generate possible continuations following this matrix.

{{matrix_block}}

[BRANCHING RULE]

Generate all choices independently from the EXACT SAME story state at the CURRENT END.

For every choice, return to that exact ending before generating it.

Choices are parallel branches, not sequential steps. A choice MUST NOT use, reference, remember, react to, or build upon anything invented in another choice. Do not allow one choice to affect any other choice.

Every choice must begin with the same:
* time
* location
* status quo
* characters present
* character knowledge
* relationships
* events
* physical and emotional circumstances

Only what happens AFTER the current ending may differ between choices.

[CONTINUATION]

Continue naturally from the current scene.
Do not time-skip. Stay close to the immediate situation and show what happens next through actions, dialogue, reactions, and relevant detail.
Make the choices meaningfully different in direction, not merely different in wording.
Prefer plausible developments over artificial drama. Do not force every story thread into every choice.
Use the provided matrices to vary the direction of the choices and avoid immediately repeating the same type of scene.

[OUTPUT RULES]

Return ONLY a valid JSON array containing exactly {{numOptions}} objects.
Each object MUST contain exactly one key: "choice".
The value MUST be actual narrative prose, not a title, explanation, summary, or reasoning.

Strict Format Example Template:
\`\`\`json
[
  {"choice":"..."},
  {"choice":"..."}
]
\`\`\``,
        defaultMatrix: [
            { range: "1", text: "Action-oriented: The character takes a direct, physical, or decisive action." },
            { range: "2", text: "Dialogue-driven: The character speaks up, asks a probing question, or confronts someone." },
            { range: "3", text: "Cautious/Defensive: The character hesitates, assesses the situation, or takes a defensive stance." },
            { range: "4", text: "Emotional/Introspective: The character reacts internally, showing vulnerability or strong emotion." },
            { range: "5", text: "Creative/Unexpected: The character does something unconventional, surprising, or out of the box." }
        ]
    };

    const DEFAULT_SETTINGS = {
        enabled: true,
        skipInterrupted: true,
        debugMode: false,
        storageMode: 'local', 
        custom_db_path: '',
        
        widget_width: 90,
        widget_left: '40%',
        widget_top: '40%',
        widget_bottom: '',
        
        modal_width: 95,
        modal_height: 90,
        modal_start: 0, 
        position: 'bottom',
        offset_top: 10,
        offset_bottom: 50,
        choice_block_max_height: 40,
        
        generationDelay: 2,
        numOptions: 5,
        includeSummary: true,
        dynamicMatrix: true,
        
        matrix: JSON.parse(JSON.stringify(defaultPrompts.defaultMatrix)),
        instructionPrompt: defaultPrompts.instructionPrompt
    };

    const bootContext = getContext();
    if (!bootContext) return;

    let isGenerating = false;
    const REGEX_FALLBACK_LIST = /^[-•.*\s\d]+[\.\:\)]?\s+/;
    let settings = {};

    let choiceContainer = null;
    let isInputManuallyEdited = false;
    let lastInsertedText = "";
    let wasInterrupted = false;
    let DOM_textarea = null; 
    let formObserver = null;
    
    // --- LOCAL INDEXED DB ---
    const DB_NAME = "ST_Choices_LocalDB";
    let localDB = null;
    
    function initLocalDB() {
        return new Promise((resolve) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains("logs")) db.createObjectStore("logs", { keyPath: "id" });
            };
            req.onsuccess = (e) => { localDB = e.target.result; resolve(true); };
            req.onerror = () => resolve(false);
        });
    }

    // Toggleable Debug Logging
    function log(text, level = 1) {
        if (settings.debugMode) {
            console.log(`%c[ST-Choices v${MODULE_VERSION}] ${text}`, level === 2 ? 'color: #8b5cf6;' : 'color: #10b981; font-weight: bold;');
        }
    }

    // Updated Format Preview
    function formatPreview(text, maxStart = 120, maxEnd = 80) {
        if (!text) return "";
        let cleanText = text.replace(/[\r\n]+/g, ' ').trim();
        if (cleanText.length <= maxStart + maxEnd + 10) return cleanText;
        return `${cleanText.substring(0, maxStart)} ... ${cleanText.substring(cleanText.length - maxEnd)}`;
    }

    async function loadSettings() {
        settings = Object.assign({}, DEFAULT_SETTINGS);
        if (bootContext.extensionSettings[MODULE_NAME]) {
            Object.assign(settings, bootContext.extensionSettings[MODULE_NAME]);
            
            const legacyKeys = ['useUserStyle', 'userStyleTemplate', 'store_ai_context', 'store_summary', 'store_full_prompt', 'store_raw_response', 'store_custom_direction', 'store_instruction_prompt'];
            legacyKeys.forEach(k => { if (settings[k] !== undefined) delete settings[k]; });
        }
        
        if (!settings.instructionPrompt || settings.instructionPrompt.trim() === "") settings.instructionPrompt = defaultPrompts.instructionPrompt;
        if (!settings.matrix || settings.matrix.length === 0) settings.matrix = JSON.parse(JSON.stringify(defaultPrompts.defaultMatrix));

        applyDynamicCSSVars();
    }

    function applyDynamicCSSVars() {
        document.documentElement.style.setProperty('--cs-panel-width', `${settings.widget_width}vw`);
        document.documentElement.style.setProperty('--cs-modal-width', `${settings.modal_width}vw`);
        document.documentElement.style.setProperty('--cs-modal-height', `${settings.modal_height}vh`);
        document.documentElement.style.setProperty('--cs-modal-start', `${settings.modal_start || 0}vh`);
        document.documentElement.style.setProperty('--cs-choices-height', `${settings.choice_block_max_height}vh`);
    }

    function injectCSS() {
        if (document.getElementById('cs_custom_css')) return;
        const style = document.createElement('style');
        style.id = 'cs_custom_css';
        style.innerHTML = `
            .cs-modal-overlay { position: fixed; inset: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.85); z-index: 999999; display: flex; justify-content: center; align-items: center; padding: 12px; box-sizing: border-box; touch-action: pan-y; backdrop-filter: blur(4px); }
            .cs-modal { margin-top: var(--cs-modal-start, 0vh); position: relative; background: var(--SmartThemeBlurTintColor, #1e1e2e); border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 10px; width: var(--cs-modal-width, 95vw); max-width: 1400px; height: var(--cs-modal-height, 90vh); max-height: calc(100vh - var(--cs-modal-start, 0vh) - 24px); display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.9); color: var(--SmartThemeBodyColor, #fff); }
            .cs-modal-header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--SmartThemeBorderColor, #444); background: rgba(0,0,0,0.25); gap: 8px; flex-wrap: wrap; }
            .cs-modal-body { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
            .cs-modal-footer { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-top: 1px solid var(--SmartThemeBorderColor, #444); background: rgba(0,0,0,0.25); gap: 10px; }
            
            .cs-touch-btn { touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer; user-select: none; }
            .cs-load-more-btn { background: rgba(139, 92, 246, 0.2); border: 1px solid rgba(139, 92, 246, 0.5); padding: 12px; text-align: center; border-radius: 6px; font-weight: bold; margin-top: 10px; }
            
            .cs-filter-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; background: rgba(0,0,0,0.15); padding: 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05); }
            .cs-stat-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 12px; background: rgba(255,255,255,0.08); font-size: 0.78rem; font-family: monospace; color: #cbd5e1; }
            
            .cs-history-cluster { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.07); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.2s; }
            .cs-history-cluster:hover { border-color: rgba(139, 92, 246, 0.4); }
            .cs-cluster-details { display: none; margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.1); flex-direction: column; gap: 8px; }
            .cs-single-option { background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.05); border-radius: 4px; padding: 8px; font-size: 0.9rem; line-height: 1.4; }
            
            .cs-failed-item { background: rgba(239, 68, 68, 0.05); border-left: 4px solid #ef4444; padding: 12px; border-radius: 0 4px 4px 0; font-family: monospace; white-space: pre-wrap; word-break: break-word; font-size: 0.88rem; max-height: 250px; overflow-y: auto; }
            
            #cs_widget_panel { display: none; flex-wrap: nowrap; align-items: center; gap: 4px; width: var(--cs-panel-width, 90vw); max-width: 600px; box-sizing: border-box; }
            #cs_widget_panel.is-open { display: flex; }
            #cs_widget_input { flex: 1 1 auto !important; min-width: 0 !important; }
            .cs_widget_action { flex: 0 0 auto !important; }
            .cs-widget-extra-btn { width: 35px !important; }
            
            .choice-stream-box { max-height: var(--cs-choices-height, 40vh); overflow-y: auto; }
        `;
        document.head.appendChild(style);
    }

    function updateContainerPosition() {
        if (!choiceContainer) return;
        let targetParent = null;
        
        if (settings.position === "bottom") {
            targetParent = document.getElementById('nonQRFormItems') || document.getElementById('send_form') || document.getElementById('form_sheld');
            if (targetParent) {
                choiceContainer.style.bottom = `calc(100% + ${parseInt(settings.offset_bottom || 50)}px)`;
                choiceContainer.style.top = 'auto';
            }
        } else {
            targetParent = document.getElementById('top-settings-holder') || document.getElementById('top-bar');
            if (targetParent) {
                choiceContainer.style.top = `calc(100% + ${parseInt(settings.offset_top || 10)}px)`;
                choiceContainer.style.bottom = 'auto';
            }
        }
        
        if (targetParent && choiceContainer.parentElement !== targetParent) {
            targetParent.appendChild(choiceContainer);
        }
    }

    async function init() {
        log("Booting Choice Stream System...", 1);
        await initLocalDB();
        await loadSettings();
        injectCSS();
        
        setTimeout(() => {
            DOM_textarea = document.getElementById("send_textarea");
            setupInputTracker();
            buildFloatingWidget();
            
            const sendForm = document.getElementById('send_form') || document.getElementById('form_sheld');
            if (sendForm && window.ResizeObserver) {
                formObserver = new ResizeObserver(() => updateContainerPosition());
                formObserver.observe(sendForm);
            }
            window.addEventListener('resize', updateContainerPosition);
        }, 2000); 
        
        const bootRetry = setInterval(() => {
            if (renderSettingsMenu() && addMagicWandButton()) clearInterval(bootRetry);
        }, 1000);

        eventSource.on('generation_stopped', (type) => { 
            if (['quiet', 'background', 'impersonate', 'summarize'].includes(type)) return;
            if (type !== 'normal' && type !== 'swipe' && type !== undefined) return;
            wasInterrupted = true; 
        });

        eventSource.on(event_types.GENERATION_STARTED, (type) => { 
            if (['quiet', 'background', 'impersonate', 'summarize'].includes(type)) return;
            if (type !== 'normal' && type !== 'swipe' && type !== undefined) return;
            wasInterrupted = false; 
            clearUI(); 
        });
        
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async () => {
            const liveContext = getContext();
            if (liveContext && liveContext.chat && liveContext.chat.length > 0) {
                const lastMsg = liveContext.chat[liveContext.chat.length - 1];
                if (lastMsg.is_system) return; 
            }

            if (settings.enabled && (!settings.skipInterrupted || !wasInterrupted)) {
                const delayMs = Math.max(600, settings.generationDelay * 1000);
                log(`Yielding ${delayMs}ms to ST main thread...`, 1);
                await new Promise(r => setTimeout(r, delayMs));
                await triggerGeneration(false);
            }
        });
        
        eventSource.on(event_types.MESSAGE_SENT, clearUI);
    }

    function setupInputTracker() {
        if (!DOM_textarea) return;
        DOM_textarea.addEventListener("input", () => {
            isInputManuallyEdited = (DOM_textarea.value.trim() !== "" && DOM_textarea.value !== lastInsertedText);
        });
    }

    function getChatIdentification() {
        const liveContext = getContext();
        let chara_name = "Unknown_Character";
        let chat_name = "Unknown_Chat";

        const domName = document.querySelector('.ch_name .name_text')?.innerText || document.getElementById('character_name_text')?.innerText;
        if (domName && domName.trim() && !domName.includes('${')) chara_name = domName.trim();
        else if (window.name2 && !window.name2.includes('${')) chara_name = window.name2;
        else if (liveContext.name2 && !liveContext.name2.includes('${')) chara_name = liveContext.name2;

        if (liveContext.chatId) {
            chat_name = liveContext.chatId;
        } else if (window.chat_metadata?.chat_id) {
            chat_name = window.chat_metadata.chat_id;
        } else if (window.chat_file_name) {
            chat_name = window.chat_file_name;
        } else if (typeof window.this_chid !== 'undefined' && window.characters && window.characters[window.this_chid]?.chat) {
            chat_name = window.characters[window.this_chid].chat;
        } else {
            const domChat = document.querySelector('.select_chat_block[highlight="true"]') || document.querySelector('.select_chat_block.selected_chat');
            if (domChat && domChat.getAttribute('file_name')) {
                chat_name = domChat.getAttribute('file_name').trim();
            }
        }

        if (chara_name === "SillyTavern System" || chara_name === "System") chara_name = "System / Utility";
        if (!chat_name) chat_name = "Unknown_Chat";

        return { chara_name, chat_name };
    }

    function extractStorySummary() {
        if (!settings.includeSummary) return "";
        const liveContext = getContext();
        let sum = "";
        
        const memContents = document.getElementById('memory_contents');
        if (memContents && memContents.value && memContents.value.trim().length > 0) sum = memContents.value.trim();

        if (!sum && window.chat_metadata?.summary) sum = window.chat_metadata.summary;
        if (!sum && liveContext.chatMetadata?.summary) sum = liveContext.chatMetadata.summary;
        if (!sum && window.extension_settings?.summarize?.summary) sum = window.extension_settings.summarize.summary;
        if (!sum && liveContext.extensionSettings?.summarize?.summary) sum = liveContext.extensionSettings.summarize.summary;
        
        if (!sum && Array.isArray(liveContext.chat)) {
            for (let i = liveContext.chat.length - 1; i >= 0; i--) {
                const mes = liveContext.chat[i]?.mes || "";
                if (liveContext.chat[i].is_system && mes) {
                    const match = mes.match(/<summary>([\s\S]*?)<\/summary>/i);
                    if (match) { sum = match[1].trim(); break; }
                    if (mes.includes("Summary:") || mes.includes("Story Summary:") || mes.includes("<memory>")) {
                        sum = mes.replace(/^Summary:/i, '').replace(/^Story Summary:/i, '').replace(/^<memory>/i, '').trim();
                        break;
                    }
                }
            }
        }
        return sum ? sum.trim() : "";
    }

    function generateUniqueId() {
        const d = new Date();
        const pad = (n, m=2) => String(n).padStart(m, '0');
        return `${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}_${Math.random().toString(36).substring(2, 8).padEnd(6, '0')}`;
    }

    function extractAIResponseContext() {
        const liveContext = getContext();
        const chat = liveContext.chat;
        if (!chat || chat.length === 0) return "No prior context.";
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system && chat[i].mes) return chat[i].mes;
        }
        return "No AI message found.";
    }

    function getApiHeaders() {
        let headers = { 'Content-Type': 'application/json' };
        try {
            if (typeof getRequestHeaders === 'function') Object.assign(headers, getRequestHeaders());
        } catch (e) {
            headers['X-CSRF-Token'] = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
        }
        return headers;
    }

    const DB = {
        async log(payload) {
            if (settings.storageMode === 'server') {
                try {
                    payload.db_path = settings.custom_db_path || "";
                    await $.ajax({ url: `${API_BASE}/log`, type: 'POST', headers: getApiHeaders(), contentType: 'application/json', data: JSON.stringify(payload) });
                    if(window.toastr) window.toastr.success(`Saved to Server DB.`, "Choices");
                } catch (e) { 
                    log("API Log Error: " + e.responseText, 1); 
                    if(window.toastr) window.toastr.error(`Server DB Error. Fallback to LocalDB recommended.`, "Backend Failure");
                }
            } else {
                if(!localDB) return;
                const tx = localDB.transaction("logs", "readwrite");
                const store = tx.objectStore("logs");
                
                const all = await this.getAll();
                payload.global_num = all.length > 0 ? all[all.length - 1].global_num + 1 : 1;
                const chatRecords = all.filter(r => r.chat_name === payload.chat_name);
                payload.chat_num = chatRecords.length > 0 ? chatRecords[chatRecords.length - 1].chat_num + 1 : 1;
                
                const orderedData = {
                    id: payload.id,
                    chara_name: payload.chara_name || "Unknown_Character",
                    chat_name: payload.chat_name || "Unknown_Chat",
                    global_num: payload.global_num,
                    chat_num: payload.chat_num,
                    status: payload.status,
                    ai_context: payload.ai_context || "",
                    story_summary: payload.story_summary || "",
                    custom_direction: payload.custom_direction || "",
                    data: payload.data || ""
                };
                
                store.add(orderedData);
                if(window.toastr) window.toastr.success(`Saved to LocalDB.`, "Choices");
            }
        },
        async getAll() {
            if (settings.storageMode === 'server') {
                try {
                    const encodedPath = encodeURIComponent(settings.custom_db_path || "");
                    return await $.ajax({ url: `${API_BASE}/db?db_path=${encodedPath}`, type: 'GET', headers: getApiHeaders(), dataType: 'json' });
                } catch (e) {
                    if (e.status === 404 && window.toastr) window.toastr.error("Choice Stream backend not found! Please run the Python script.", "Backend Error");
                    return [];
                }
            } else {
                return new Promise(resolve => {
                    if(!localDB) return resolve([]);
                    const tx = localDB.transaction("logs", "readonly");
                    const req = tx.objectStore("logs").getAll();
                    req.onsuccess = () => resolve(req.result || []);
                });
            }
        },
        async delete(id) {
            if (settings.storageMode === 'server') {
                try { await $.ajax({ url: `${API_BASE}/delete`, type: 'POST', headers: getApiHeaders(), contentType: 'application/json', data: JSON.stringify({ id: id, db_path: settings.custom_db_path || "" }) }); } catch (e) {}
            } else {
                if(!localDB) return;
                localDB.transaction("logs", "readwrite").objectStore("logs").delete(id);
            }
        },
        async clear(type) {
            if (settings.storageMode === 'server') {
                try { await $.ajax({ url: `${API_BASE}/clear`, type: 'POST', headers: getApiHeaders(), contentType: 'application/json', data: JSON.stringify({ type: type, db_path: settings.custom_db_path || "" }) }); } catch (e) {}
            } else {
                if(!localDB) return;
                if (type === "ALL") localDB.transaction("logs", "readwrite").objectStore("logs").clear();
                else {
                    const all = await this.getAll();
                    const tx = localDB.transaction("logs", "readwrite");
                    const store = tx.objectStore("logs");
                    all.filter(r => r.status === type).forEach(r => store.delete(r.id));
                }
            }
        }
    };

    function bindTapClose(element, callback) {
        if (!element) return;
        let touched = false;
        element.addEventListener('touchend', (e) => {
            touched = true; e.preventDefault(); e.stopPropagation(); callback();
        }, { passive: false });
        element.addEventListener('click', (e) => {
            if (touched) { touched = false; return; } e.preventDefault(); e.stopPropagation(); callback();
        });
    }

    async function showHistoryModal(filterChat = "__ALL__", searchKeyword = "") {
        if (document.getElementById('cs_history_modal')) document.getElementById('cs_history_modal').remove();
        
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'cs_history_modal';
        modalOverlay.className = 'cs-modal-overlay';
        
        const { chat_name } = getChatIdentification();
        let allRecords = await DB.getAll();
        
        let allClusters = allRecords.filter(r => r.status === "SUCCESS");
        allClusters.sort((a,b) => (b.global_num || 0) - (a.global_num || 0));
        
        const chatKeysMap = {};
        allClusters.forEach(c => {
            if (c.chat_name) chatKeysMap[c.chat_name] = c.chara_name || "Unknown_Character";
        });

        let filtered = allClusters;
        if (filterChat !== "__ALL__") filtered = filtered.filter(c => c.chat_name === filterChat);
        if (searchKeyword.trim() !== "") {
            const kw = searchKeyword.toLowerCase();
            filtered = filtered.filter(c => 
                (c.chat_name && c.chat_name.toLowerCase().includes(kw)) || 
                (c.chara_name && c.chara_name.toLowerCase().includes(kw)) || 
                (c.data && Array.isArray(c.data) && c.data.some(choice => choice.toLowerCase().includes(kw))) ||
                (c.custom_direction && c.custom_direction.toLowerCase().includes(kw)) ||
                (c.ai_context && c.ai_context.toLowerCase().includes(kw))
            );
        }

        let chatOptionsHtml = `<option value="__ALL__" ${filterChat === '__ALL__' ? 'selected' : ''}>All Chats (${allClusters.length} saves)</option>`;
        const chatKeysArr = Object.keys(chatKeysMap).sort((a,b) => {
            if (a === chat_name) return -1;
            if (b === chat_name) return 1;
            return a.localeCompare(b);
        });
        
        chatKeysArr.forEach(cId => {
            const isCurr = cId === chat_name ? '★ [Current] ' : '';
            const count = allClusters.filter(c => c.chat_name === cId).length;
            chatOptionsHtml += `<option value="${cId}" ${filterChat === cId ? 'selected' : ''}>${isCurr}${cId} (${count})</option>`;
        });

        modalOverlay.innerHTML = `
            <div class="cs-modal">
                <div class="cs-modal-header">
                    <span style="font-size:1.1rem;"><i class="fa-solid fa-clock-rotate-left"></i> Choice Database</span>
                    <div style="display:flex; gap:8px;">
                        <button id="cs_hist_clearall_btn" class="menu_button cs-touch-btn margin0" style="color:#ef4444;"><i class="fa-solid fa-trash"></i> Wipe DB</button>
                        <button id="cs_hist_head_close" class="menu_button cs-touch-btn margin0" style="background:rgba(239,68,68,0.2);"><i class="fa-solid fa-xmark"></i> Close</button>
                    </div>
                </div>
                <div style="padding:10px 12px; flex:0 0 auto;">
                    <div class="cs-filter-bar">
                        <select id="cs_hist_chat_select" class="text_pole" style="flex:1; min-width:180px;">${chatOptionsHtml}</select>
                        <input type="text" id="cs_hist_search_input" class="text_pole" placeholder="Search keywords..." value="${searchKeyword}" style="flex:1; min-width:140px;">
                    </div>
                </div>
                <div id="cs_hist_body" class="cs-modal-body"></div>
                <div class="cs-modal-footer">
                    <div style="font-size:0.85rem; color:#94a3b8;">Showing <b id="cs_hist_count">0</b> of <b>${allClusters.length}</b> records</div>
                    <button id="cs_hist_foot_close" class="menu_button cs-touch-btn margin0" style="min-width:100px; font-weight:bold;"><i class="fa-solid fa-check"></i> Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalOverlay);

        const bodyContainer = document.getElementById('cs_hist_body');
        const countDisplay = document.getElementById('cs_hist_count');
        
        let currentIndex = 0;
        const CHUNK_SIZE = 15;
        let loadMoreBtn = document.createElement('div');
        loadMoreBtn.className = "cs-load-more-btn cs-touch-btn";
        loadMoreBtn.innerHTML = "<i class='fa-solid fa-angles-down'></i> Load More";
        loadMoreBtn.onclick = () => renderChunk();

        function renderChunk() {
            if (filtered.length === 0) {
                bodyContainer.innerHTML = `<div style="text-align:center; padding: 40px 10px; color: rgba(255,255,255,0.4);">No saved choice history matches the criteria.</div>`;
                return;
            }

            const slice = filtered.slice(currentIndex, currentIndex + CHUNK_SIZE);
            let chunkHtml = "";
            
            slice.forEach(cluster => {
                const choicesArray = Array.isArray(cluster.data) ? cluster.data : (cluster.choices || []);
                const totalWords = choicesArray.reduce((acc, c) => acc + (c.trim() ? c.trim().split(/\s+/).length : 0), 0);
                const rawId = cluster.id || "Unknown";
                const displayId = rawId.includes('_') ? rawId.split('_')[0] : rawId;

                chunkHtml += `
                    <div class="cs-history-cluster" data-id="${cluster.id}">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:6px;">
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <div style="font-weight:bold; font-size:0.95rem; color:#a78bfa;">
                                    ${cluster.chat_name} <span style="font-size:0.75rem; color:#94a3b8; font-weight:normal;">(${cluster.chara_name})</span>
                                </div>
                                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                    <span class="cs-stat-pill" title="Global DB Num">G# ${cluster.global_num}</span>
                                    <span class="cs-stat-pill" title="Timestamp ID"><i class="fa-solid fa-clock"></i> ${displayId}</span>
                                    <span class="cs-stat-pill" style="color:#38bdf8;"><i class="fa-solid fa-list-ol"></i> ${choicesArray.length} options</span>
                                    <span class="cs-stat-pill"><i class="fa-solid fa-font"></i> ${totalWords}w</span>
                                </div>
                                ${cluster.custom_direction ? `<div style="font-size:0.8rem; color:#f472b6;"><b>Direction:</b> "${cluster.custom_direction}"</div>` : ''}
                            </div>
                            <div style="display:flex; gap:8px;">
                                <button class="menu_button cs-touch-btn cs-load-cluster-btn margin0" style="padding:4px 8px; font-size:0.8rem; color:#10b981;" title="Load into choices UI"><i class="fa-solid fa-arrow-up-right-from-square"></i> Use</button>
                                <button class="menu_button cs-touch-btn cs-del-cluster-btn margin0" style="padding:4px 8px; font-size:0.8rem; color:#ef4444;" title="Delete this cluster"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>

                        <div class="cs-cluster-preview" style="font-size:0.88rem; opacity:0.85; margin-top:8px;">
                            ${choicesArray.map((c, i) => `<div><span style="color:#8b5cf6;">[${i+1}]</span> ${formatPreview(c).replace(/</g, '&lt;')}</div>`).join('')}
                        </div>

                        <div class="cs-toggle-inspect" style="font-size:0.8rem; color:#8b5cf6; cursor:pointer; text-decoration:underline; margin-top:6px;">
                            <i class="fa-solid fa-chevron-down"></i> Inspect Full Options & Context
                        </div>

                        <div class="cs-cluster-details">
                            ${cluster.ai_context ? `
                            <div style="font-size:0.8rem; background:rgba(0,0,0,0.3); padding:8px; border-radius:4px; border-left:3px solid #8b5cf6;">
                                <b style="color:#a78bfa;">AI Context Snippet:</b>
                                <div style="margin-top:4px; max-height:80px; overflow-y:auto; opacity:0.85;">${formatPreview(cluster.ai_context).replace(/</g, '&lt;')}</div>
                            </div>` : ''}
                            
                            ${choicesArray.map((c, i) => `
                                <div class="cs-single-option">
                                    <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:0.8rem; color:#94a3b8;">
                                        <span><b>Option ${i+1}</b></span>
                                        <div style="display:flex; gap:6px;">
                                            <button class="cs-copy-single-btn menu_button cs-touch-btn margin0" data-text="${encodeURIComponent(c)}" style="padding:2px 6px; font-size:0.75rem;"><i class="fa-solid fa-copy"></i> Copy</button>
                                            <button class="cs-insert-single-btn menu_button cs-touch-btn margin0" data-text="${encodeURIComponent(c)}" style="padding:2px 6px; font-size:0.75rem; color:#10b981;"><i class="fa-solid fa-pen-to-square"></i> Send</button>
                                        </div>
                                    </div>
                                    <div>${c.replace(/</g, '&lt;')}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            });
            
            if(loadMoreBtn.parentNode) loadMoreBtn.parentNode.removeChild(loadMoreBtn);
            bodyContainer.insertAdjacentHTML('beforeend', chunkHtml);
            
            currentIndex += CHUNK_SIZE;
            countDisplay.innerText = Math.min(currentIndex, filtered.length);
            
            if (currentIndex < filtered.length) {
                bodyContainer.appendChild(loadMoreBtn);
            }
        }
        renderChunk();

        bodyContainer.addEventListener('click', async (e) => {
            const toggle = e.target.closest('.cs-toggle-inspect');
            if (toggle) {
                const details = toggle.nextElementSibling;
                const isOpen = details.style.display === 'flex';
                details.style.display = isOpen ? 'none' : 'flex';
                toggle.innerHTML = isOpen ? '<i class="fa-solid fa-chevron-down"></i> Inspect Full Options & Context' : '<i class="fa-solid fa-chevron-up"></i> Hide Full Options';
                return;
            }

            const loadBtn = e.target.closest('.cs-load-cluster-btn');
            if (loadBtn) {
                const id = loadBtn.closest('.cs-history-cluster').getAttribute('data-id');
                const cluster = filtered.find(c => c.id === id);
                if (cluster && cluster.data) renderChoices(cluster.data);
                closeModal();
                return;
            }

            const delBtn = e.target.closest('.cs-del-cluster-btn');
            if (delBtn) {
                const id = delBtn.closest('.cs-history-cluster').getAttribute('data-id');
                await DB.delete(id);
                showHistoryModal($('#cs_hist_chat_select').val(), $('#cs_hist_search_input').val());
                return;
            }

            const copyBtn = e.target.closest('.cs-copy-single-btn');
            if (copyBtn) {
                const text = decodeURIComponent(copyBtn.getAttribute('data-text'));
                navigator.clipboard.writeText(text).then(() => {
                    const oldHtml = copyBtn.innerHTML;
                    copyBtn.innerHTML = `<i class="fa-solid fa-check"></i>`;
                    copyBtn.style.color = '#10b981';
                    setTimeout(() => { copyBtn.innerHTML = oldHtml; copyBtn.style.color = ''; }, 1500);
                });
                return;
            }

            const insertBtn = e.target.closest('.cs-insert-single-btn');
            if (insertBtn) {
                const text = decodeURIComponent(insertBtn.getAttribute('data-text'));
                if (!DOM_textarea) DOM_textarea = document.getElementById("send_textarea");
                if (DOM_textarea) {
                    DOM_textarea.value = text;
                    lastInsertedText = text;
                    DOM_textarea.dispatchEvent(new Event("input", { bubbles: true }));
                    DOM_textarea.focus();
                }
                closeModal();
                return;
            }
        });

        const closeModal = () => modalOverlay.remove();
        bindTapClose(document.getElementById('cs_hist_head_close'), closeModal);
        bindTapClose(document.getElementById('cs_hist_foot_close'), closeModal);
        modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

        $('#cs_hist_chat_select').on('change', function() { showHistoryModal(this.value, $('#cs_hist_search_input').val()); });
        $('#cs_hist_search_input').on('input', function() {
            const val = this.value;
            clearTimeout(window.__cs_search_timer);
            window.__cs_search_timer = setTimeout(() => { showHistoryModal($('#cs_hist_chat_select').val(), val); }, 1000);
        });

        document.getElementById('cs_hist_clearall_btn').onclick = async () => {
            if (confirm("WARNING: This will permanently delete ALL successful choice history records.\n\nProceed?")) {
                if (confirm("SECOND CONFIRMATION:\n\nAre you absolutely sure? This CANNOT be undone.")) {
                    await DB.clear("SUCCESS");
                    showHistoryModal();
                }
            }
        };
    }

    async function showFailedModal() {
        if (document.getElementById('cs_failed_modal')) document.getElementById('cs_failed_modal').remove();
        
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'cs_failed_modal';
        modalOverlay.className = 'cs-modal-overlay';
        
        let allRecords = await DB.getAll();
        const fails = allRecords.filter(r => r.status === "FAIL");
        fails.sort((a,b) => (b.global_num || 0) - (a.global_num || 0));

        modalOverlay.innerHTML = `
            <div class="cs-modal">
                <div class="cs-modal-header">
                    <span style="font-size:1.1rem;"><i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i> Unparsed Raw Responses (${fails.length})</span>
                    <div style="display:flex; gap:8px;">
                        <button id="cs_fail_clearall_btn" class="menu_button cs-touch-btn margin0" style="color:#ef4444;"><i class="fa-solid fa-trash"></i> Clear All</button>
                        <button id="cs_fail_head_close" class="menu_button cs-touch-btn margin0" style="background:rgba(239,68,68,0.2);"><i class="fa-solid fa-xmark"></i> Close</button>
                    </div>
                </div>
                <div id="cs_fail_body" class="cs-modal-body"></div>
                <div class="cs-modal-footer">
                    <div style="font-size:0.85rem; color:#94a3b8;">Showing <b id="cs_fail_count">0</b> fails.</div>
                    <button id="cs_fail_foot_close" class="menu_button cs-touch-btn margin0" style="min-width:100px; font-weight:bold;"><i class="fa-solid fa-check"></i> Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalOverlay);

        const bodyContainer = document.getElementById('cs_fail_body');
        const countDisplay = document.getElementById('cs_fail_count');

        let currentIndex = 0;
        const CHUNK_SIZE = 15;
        let loadMoreBtn = document.createElement('div');
        loadMoreBtn.className = "cs-load-more-btn cs-touch-btn";
        loadMoreBtn.innerHTML = "<i class='fa-solid fa-angles-down'></i> Load More";
        loadMoreBtn.onclick = () => renderChunk();

        function renderChunk() {
            if (fails.length === 0) {
                bodyContainer.innerHTML = `<div style="text-align:center; padding: 40px 10px; color: rgba(255,255,255,0.4);">No unparsed LLM responses recorded. Everything is parsing smoothly!</div>`;
                return;
            }

            const slice = fails.slice(currentIndex, currentIndex + CHUNK_SIZE);
            let chunkHtml = "";

            slice.forEach(fail => {
                const rawString = typeof fail.data === 'string' ? fail.data : (fail.raw_response || "");
                const wordCount = rawString.trim().split(/\s+/).length;
                const rawId = fail.id || "Unknown";
                const displayId = rawId.includes('_') ? rawId.split('_')[0] : rawId;

                chunkHtml += `
                    <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.07); border-radius:6px; padding:10px;">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
                            <div>
                                <b style="color:#ef4444;">${fail.chat_name}</b> <span style="font-size:0.75rem; color:#94a3b8;">(${fail.chara_name})</span>
                                <div style="display:flex; gap:6px; margin-top:3px; flex-wrap:wrap;">
                                    <span class="cs-stat-pill" title="Global DB Num">G# ${fail.global_num}</span>
                                    <span class="cs-stat-pill" title="Timestamp ID"><i class="fa-solid fa-clock"></i> ${displayId}</span>
                                    <span class="cs-stat-pill">${wordCount} words</span>
                                </div>
                            </div>
                            <div style="display:flex; gap:8px;">
                                <button class="menu_button cs-touch-btn cs-fail-copy-btn margin0" data-text="${encodeURIComponent(rawString)}"><i class="fa-solid fa-copy"></i> Copy</button>
                                <button class="menu_button cs-touch-btn cs-fail-del-btn margin0" data-id="${fail.id}" style="color:#ef4444;"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>
                        ${fail.ai_context ? `<div style="font-size: 0.82rem; color: #cbd5e1; margin-bottom: 8px; font-style: italic; border-left: 2px solid #ef4444; padding-left: 6px;">
                            <b>Failed context snippet:</b> "${formatPreview(fail.ai_context).replace(/</g, '&lt;')}"
                        </div>` : ''}
                        <div class="cs-failed-item">${rawString.replace(/</g, '&lt;')}</div>
                    </div>
                `;
            });
            
            if(loadMoreBtn.parentNode) loadMoreBtn.parentNode.removeChild(loadMoreBtn);
            bodyContainer.insertAdjacentHTML('beforeend', chunkHtml);
            
            currentIndex += CHUNK_SIZE;
            countDisplay.innerText = Math.min(currentIndex, fails.length);
            
            if (currentIndex < fails.length) bodyContainer.appendChild(loadMoreBtn);
        }
        renderChunk();

        bodyContainer.addEventListener('click', async (e) => {
            const copyBtn = e.target.closest('.cs-fail-copy-btn');
            if (copyBtn) {
                const text = decodeURIComponent(copyBtn.getAttribute('data-text'));
                navigator.clipboard.writeText(text).then(() => {
                    const oldHtml = copyBtn.innerHTML;
                    copyBtn.innerHTML = `<i class="fa-solid fa-check"></i>`;
                    copyBtn.style.color = '#10b981';
                    setTimeout(() => { copyBtn.innerHTML = oldHtml; copyBtn.style.color = ''; }, 1500);
                });
                return;
            }
            const delBtn = e.target.closest('.cs-fail-del-btn');
            if (delBtn) {
                const id = delBtn.getAttribute('data-id');
                await DB.delete(id);
                showFailedModal();
                return;
            }
        });

        const closeModal = () => modalOverlay.remove();
        bindTapClose(document.getElementById('cs_fail_head_close'), closeModal);
        bindTapClose(document.getElementById('cs_fail_foot_close'), closeModal);
        modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

        document.getElementById('cs_fail_clearall_btn').onclick = async () => {
            if (confirm("WARNING: This will permanently delete ALL failed parse records.\n\nProceed?")) {
                if (confirm("SECOND CONFIRMATION:\n\nAre you sure you want to wipe the fails database? This CANNOT be undone.")) {
                    await DB.clear("FAIL");
                    showFailedModal();
                }
            }
        };
    }

    function buildFloatingWidget() {
        if (document.getElementById('cs_floating_widget')) return;

        const widget = document.createElement('div');
        widget.id = 'cs_floating_widget';
        widget.style.left = settings.widget_left;
        if (settings.widget_top) widget.style.top = settings.widget_top;
        if (settings.widget_bottom) widget.style.bottom = settings.widget_bottom;

        widget.innerHTML = `
            <div id="cs_widget_btn" class="cs-touch-btn" title="Drag to move. Click to toggle.">
                <i class="fa-solid fa-code-branch"></i>
            </div>
            <div id="cs_widget_panel">
                <input type="text" id="cs_widget_input" placeholder="Custom direction..." autocomplete="off">
                <button class="cs_widget_action cs-widget-extra-btn cs-touch-btn" id="cs_widget_history" title="Choice History"><i class="fa-solid fa-clock-rotate-left"></i></button>
                <button class="cs_widget_action cs-widget-extra-btn cs-touch-btn" id="cs_widget_fails" title="Failed Parses"><i class="fa-solid fa-triangle-exclamation"></i></button>
                <button class="cs_widget_action cs-touch-btn" id="cs_widget_go" title="Generate Choices"><i class="fa-solid fa-play"></i></button>
                <button class="cs_widget_action cs-touch-btn" id="cs_widget_close" title="Close Panel"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `;
        document.body.appendChild(widget);

        const btn = document.getElementById('cs_widget_btn');
        const panel = document.getElementById('cs_widget_panel');
        const input = document.getElementById('cs_widget_input');
        const goBtn = document.getElementById('cs_widget_go');
        const closeBtn = document.getElementById('cs_widget_close');

        let isDragging = false;
        let startX, startY;

        function onDragStart(e) {
            startX = e.clientX || (e.touches ? e.touches[0].clientX : 0);
            startY = e.clientY || (e.touches ? e.touches[0].clientY : 0);
            isDragging = false;

            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('touchmove', onDragMove, { passive: false });
            document.addEventListener('mouseup', onDragEnd);
            document.addEventListener('touchend', onDragEnd, { passive: false });
        }

        function onDragMove(e) {
            let currentX = e.clientX || (e.touches ? e.touches[0].clientX : 0);
            let currentY = e.clientY || (e.touches ? e.touches[0].clientY : 0);

            if (Math.abs(currentX - startX) > 5 || Math.abs(currentY - startY) > 5) {
                isDragging = true;
            }
            if (isDragging) {
                if (e.cancelable) e.preventDefault(); 
                widget.style.bottom = 'auto'; 
                widget.style.right = 'auto';
                widget.style.left = (widget.offsetLeft + (currentX - startX)) + 'px';
                widget.style.top = (widget.offsetTop + (currentY - startY)) + 'px';
                startX = currentX;
                startY = currentY;
            }
        }

        function onDragEnd(e) {
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('touchmove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);
            document.removeEventListener('touchend', onDragEnd);
            
            if (!isDragging) {
                if (e.type === 'touchend' && e.cancelable) e.preventDefault(); 
                
                if (panel.classList.contains('is-open')) {
                    panel.classList.remove('is-open');
                    input.blur();
                } else {
                    panel.classList.add('is-open');
                }
            } else {
                settings.widget_left = widget.style.left;
                settings.widget_top = widget.style.top;
                settings.widget_bottom = ''; 
                save();
            }
        }

        btn.addEventListener('mousedown', onDragStart);
        btn.addEventListener('touchstart', onDragStart, { passive: true });

        function submitGeneration() {
            panel.classList.remove('is-open');
            const direction = input.value;
            input.value = ''; 
            clearUI();
            triggerGeneration(false, direction);
        }

        goBtn.onclick = submitGeneration;
        closeBtn.onclick = () => panel.classList.remove('is-open');
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitGeneration();
            }
        });
        
        document.getElementById('cs_widget_history').onclick = () => showHistoryModal();
        document.getElementById('cs_widget_fails').onclick = () => showFailedModal();
    }

    function addMagicWandButton() {
        const wandMenu = document.getElementById("extensionsMenu");
        if (!wandMenu || document.getElementById("cs_wand_btn")) return !!document.getElementById("cs_wand_btn"); 

        const btn = document.createElement("div");
        btn.id = "cs_wand_btn";
        btn.className = "list-group-item flex-container flexGap5 interactable cs-touch-btn";
        btn.onclick = (e) => { 
            e.stopPropagation(); 
            $("#extensionsMenu").hide(); 
            clearUI(); 
            triggerGeneration(false); 
        };
        btn.innerHTML = `<div class="fa-fw fa-solid fa-list-ul extensionsMenuExtensionButton"></div><span>Generate Story Choices</span>`;
        
        const listGroup = wandMenu.querySelector('.list-group') || wandMenu;
        listGroup.prepend(btn);
        return true;
    }

    function parseRangeString(str, maxOptions = 999) {
        let indices = new Set();
        let parts = String(str || "").split(',');
        for (let p of parts) {
            p = p.trim();
            if (p.includes('-')) {
                let [s, e] = p.split('-').map(Number);
                if (!isNaN(s) && !isNaN(e)) {
                    let min = Math.min(s, e);
                    let max = Math.max(s, e);
                    for (let i = min; i <= max; i++) {
                        if (i <= maxOptions && i > 0) indices.add(i);
                    }
                }
            } else {
                let n = Number(p);
                if (!isNaN(n) && n <= maxOptions && n > 0) indices.add(n);
            }
        }
        return Array.from(indices).sort((a, b) => a - b);
    }

    function getResolvedMatrix(maxOptions) {
        let assigned = new Set();
        let resolvedRules = [];
        
        if (!settings.dynamicMatrix || !settings.matrix || settings.matrix.length === 0) return resolvedRules;

        settings.matrix.forEach(rule => {
            let targets = [];
            let parsedIndices = parseRangeString(rule.range, maxOptions);
            
            parsedIndices.forEach(i => {
                if (!assigned.has(i)) {
                    assigned.add(i);
                    targets.push(i);
                }
            });
            
            if (targets.length > 0) {
                resolvedRules.push({ targets: targets, text: rule.text });
            }
        });
        return resolvedRules;
    }

    function buildMatrixPrompt() {
        let maxOptions = parseInt(settings.numOptions);
        let resolvedRules = getResolvedMatrix(maxOptions);
        
        if (resolvedRules.length === 0) {
            return `Generate exactly ${maxOptions} distinct action/dialogue choices.\n`;
        }
        
        let matrixStr = `Generate exactly ${maxOptions} distinct action/dialogue choices following this precise matrix:\n`;
        resolvedRules.forEach(rule => {
            let targetsStr = rule.targets.length === 1 ? rule.targets[0].toString() : rule.targets.join(', ');
            matrixStr += `- Option${rule.targets.length > 1 ? 's' : ''} ${targetsStr}: ${rule.text}\n`;
        });
        return matrixStr.trim();
    }

    async function triggerGeneration(isTest = false, customDirection = "") {
        if (isGenerating) {
            log("Generation already in progress.", 1);
            if (window.toastr) window.toastr.info("Choices generation already in progress...", "Please Wait");
            return;
        }

        const goBtnIcon = document.querySelector('#cs_widget_go i');
        if (goBtnIcon) goBtnIcon.className = "fa-solid fa-hourglass-half fa-spin";
        
        if (isTest) {
            renderChoices([
                "I slowly back away from the door, my heart hammering against my ribs as the realization sets in. 'We can't stay here,' I whisper, grabbing my coat from the chair. Without waiting for a response, I move to the window, scanning the dark treeline for any sign of movement while frantically trying to piece together a new escape plan.", 
                "I force a calm smile, crossing my arms to hide my shaking hands. 'That's a very interesting theory,' I reply, keeping my voice perfectly level. I take a deliberate step toward the center of the room, ensuring I'm standing between them and the locked desk drawer containing the actual documents."
            ]);
            if (goBtnIcon) goBtnIcon.className = "fa-solid fa-play";
            return;
        }

        const liveContext = getContext();
        const chat = liveContext.chat;
        if (!chat?.length || chat[chat.length - 1].is_user) {
            log("Cannot generate choices: Last message in chat is from the user.", 2);
            if (window.toastr) window.toastr.warning("You must wait for the character to reply before generating choices.", "Generation Blocked");
            if (goBtnIcon) goBtnIcon.className = "fa-solid fa-play";
            return;
        }

        isGenerating = true;
        const storySummary = extractStorySummary();
        const dynamicMatrix = buildMatrixPrompt();
        let compiledPrompt = "";
        let rawResponse = "";
        let choices = [];
        let isSuccess = false;
        
        try {
            log(`Fetching ${settings.numOptions} choices from backend...`, 1);

            let stInstruction = settings.instructionPrompt
                .replaceAll("{{numOptions}}", settings.numOptions)
                .replaceAll("{{matrix_block}}", dynamicMatrix);

            if (customDirection && customDirection.trim() !== "") {
                const dirPrompt = `\n=====\nTARGET NARRATIVE DIRECTION\nALL choices MUST strictly execute or revolve around this specific intent: "${customDirection.trim()}"\nDO NOT deviate from this core premise!\n=====\n`;
                if (stInstruction.includes("CRITICAL RULES")) {
                    stInstruction = stInstruction.replace("CRITICAL RULES", `${dirPrompt}\nCRITICAL RULES`);
                } else {
                    if (stInstruction.endsWith("]")) stInstruction = stInstruction.slice(0, -1) + `\n${dirPrompt}]`;
                    else stInstruction += `\n${dirPrompt}`;
                }
            }

            compiledPrompt = stInstruction;
            
            rawResponse = await executeWithRetry(() => fetchRaw(compiledPrompt), 1, 3000);
            choices = parseLLMArray(rawResponse);
            
            if (choices && choices.length > 0) {
                isSuccess = true;
                renderChoices(choices);
            } else {
                throw new Error("Failed to parse choices from response");
            }
        } catch (e) { 
            log("Fetch/Parse failed: " + e.message, 1); 
            if (window.toastr) window.toastr.error("Failed to generate options: " + e.message, "Choices Error");
        } finally {
            isGenerating = false;
            if (goBtnIcon) goBtnIcon.className = "fa-solid fa-play";
            
            if (rawResponse) {
                const { chara_name, chat_name } = getChatIdentification();
                const payload = {
                    id: generateUniqueId(),
                    chara_name: chara_name,
                    chat_name: chat_name,
                    status: isSuccess ? "SUCCESS" : "FAIL",
                    ai_context: extractAIResponseContext(),
                    story_summary: storySummary, 
                    custom_direction: customDirection.trim(),
                    data: isSuccess ? choices : rawResponse
                };

                DB.log(payload);
            }
        }
    }

    async function fetchRaw(compiledPrompt) {
        log(`SENDING QUIET PROMPT:\n${compiledPrompt}`, 2);
        let rawResponse = await generateQuietPrompt({ quietPrompt: compiledPrompt, skipWIAN: false, removeReasoning: true });
        if (!rawResponse || rawResponse.trim() === "") throw new Error("Empty response from ST Proxy");
        log(`RAW LLM RESPONSE:\n${rawResponse}`, 2);
        return rawResponse;
    }

    async function executeWithRetry(fn, maxRetries, delayMs) {
        for (let i = 0; i < maxRetries; i++) {
            try { return await fn(); } 
            catch (err) {
                log(`API Error (Attempt ${i + 1}/${maxRetries}): ${err.message}`, 1);
                if (i === maxRetries - 1) throw err;
                await new Promise(r => setTimeout(r, delayMs)); 
            }
        }
    }

    function sanitizeOption(text) {
        if (!text) return "";
        let s = text.trim();
        s = s.replace(/\\"/g, '"');
        s = s.replace(/\\n/g, ' '); 
        s = s.replace(/^[,\]\s:]+/, '').replace(/[,\[\s:]+$/, '');
        
        if (s.startsWith('""') && s.endsWith('""') && s.length > 4) {
            s = s.substring(2, s.length - 2);
        } else if (s.startsWith('"') && s.endsWith('"') && s.length > 2) {
            s = s.substring(1, s.length - 1);
        }
        
        s = s.replace(REGEX_FALLBACK_LIST, '');
        return s.trim();
    }

    function parseLLMArray(rawText) {
        let cleanText = rawText.trim();
        let choices = [];

        let firstBracket = cleanText.indexOf('[');
        let lastBracket = cleanText.lastIndexOf(']');
        let jsonStr = cleanText;
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
            jsonStr = cleanText.substring(firstBracket, lastBracket + 1);
        }

        try {
            let parseableStr = jsonStr.replace(/```(?:json)?|```/gi, '').trim();
            parseableStr = parseableStr.replace(/,\s*([\]}])/g, '$1'); 
            
            const parsed = JSON.parse(parseableStr);
            if (Array.isArray(parsed)) {
                for (let obj of parsed) {
                    if (obj.choice && typeof obj.choice === 'string') {
                        let text = obj.choice.trim();
                        if (text.length > 0) choices.push(text);
                    }
                }
                if (choices.length > 0) return choices;
            }
        } catch (e) {
            log("Native JSON.parse failed, falling back to Regex extraction...", 2);
        }

        const choiceRegex = /"choice"\s*:\s*"([\s\S]*?)"(?=\s*(?:,|$}|\n|\}))/gi;
        let match;
        while ((match = choiceRegex.exec(jsonStr)) !== null) {
            let text = sanitizeOption(match[1]);
            if (text.length > 0) choices.push(text);
        }

        if (choices.length > 0) return choices;

        log("Activating Aggressive Bracket Extraction...", 2);
        let blocks = jsonStr.match(/\{([\s\S]*?)\}/g);
        if (blocks) {
            for (let b of blocks) {
                let content = b.replace(/^\{\s*(?:"choice"\s*:\s*)?/, '').replace(/\s*\}$/, '');
                content = sanitizeOption(content);
                if (content.length > 10) choices.push(content);
            }
        }

        if (choices.length > 0) return choices;

        for (let line of cleanText.split('\n')) {
            let trimmed = line.trim();
            if (REGEX_FALLBACK_LIST.test(trimmed)) {
                let cleanOpt = sanitizeOption(trimmed.replace(REGEX_FALLBACK_LIST, ''));
                if (cleanOpt.length > 0) choices.push(cleanOpt);
            }
        }

        return choices.length > 0 ? choices : null;
    }

    function renderChoices(choices) {
        try {
            clearUI();
            
            choiceContainer = document.createElement("div");
            choiceContainer.className = "choice-stream-container";
            choiceContainer.id = "active_choice_stream_ui"; 

            const fragment = document.createDocumentFragment();

            const controls = document.createElement("div");
            controls.className = "choice-stream-controls";
            
            const minBtn = document.createElement("button");
            minBtn.className = "choice-stream-util-btn interactable cs-touch-btn";
            minBtn.innerHTML = "<i class='fa-solid fa-minus'></i>";
            
            const closeBtn = document.createElement("button");
            closeBtn.className = "choice-stream-util-btn interactable cs-touch-btn";
            closeBtn.innerHTML = "<i class='fa-solid fa-xmark'></i>";
            
            closeBtn.onclick = (e) => { e.stopPropagation(); clearUI(); };

            minBtn.onclick = (e) => { 
                e.stopPropagation(); 
                choiceContainer.classList.toggle("choice-stream-minimized"); 
                minBtn.innerHTML = choiceContainer.classList.contains("choice-stream-minimized") 
                    ? "<i class='fa-solid fa-plus'></i>" 
                    : "<i class='fa-solid fa-minus'></i>";
                updateContainerPosition(); 
            };
            
            controls.append(minBtn, closeBtn);
            fragment.appendChild(controls);

            const box = document.createElement("div");
            box.className = "choice-stream-box";

            choices.slice(0, settings.numOptions).forEach((text, index) => {
                const card = document.createElement("div");
                card.className = "choice-stream-card is-collapsed"; 
                card.id = `choice_card_${index}`;

                const toggleBtn = document.createElement("div");
                toggleBtn.className = "choice-card-toggle interactable cs-touch-btn";
                toggleBtn.innerHTML = "<i class='fa-solid fa-chevron-right choice-card-toggle-icon'></i>";
                
                toggleBtn.onclick = (e) => {
                    e.stopPropagation();
                    card.classList.toggle("is-collapsed");
                };

                const btn = document.createElement("button");
                btn.className = "choice-stream-btn interactable cs-touch-btn";
                btn.innerText = text;
                btn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!DOM_textarea) DOM_textarea = document.getElementById("send_textarea");
                    if (isInputManuallyEdited) {
                        const start = DOM_textarea.selectionStart;
                        DOM_textarea.value = DOM_textarea.value.slice(0, start) + text + DOM_textarea.value.slice(DOM_textarea.selectionEnd);
                    } else DOM_textarea.value = text;
                    
                    lastInsertedText = DOM_textarea.value;
                    DOM_textarea.dispatchEvent(new Event("input", { bubbles: true }));
                    DOM_textarea.focus();
                };

                const cardCloseBtn = document.createElement("div");
                cardCloseBtn.className = "choice-card-close interactable cs-touch-btn";
                cardCloseBtn.innerHTML = "<i class='fa-solid fa-xmark'></i>";
                cardCloseBtn.onclick = (e) => {
                    e.stopPropagation();
                    card.remove(); 
                };

                card.append(toggleBtn, btn, cardCloseBtn);
                box.append(card);
            });
            
            fragment.appendChild(box);
            choiceContainer.appendChild(fragment);
            updateContainerPosition(); 
            
        } catch (e) {
            log("Error rendering UI: " + e.message, 1);
        }
    }

    function clearUI() {
        if (choiceContainer) { choiceContainer.remove(); choiceContainer = null; }
        const ghost = document.getElementById("active_choice_stream_ui");
        if (ghost) ghost.remove();
    }
    
    function updateMatrixUI() {
        const container = document.getElementById("cs_matrix_list");
        if (!container) return;
        container.innerHTML = '';
        
        let maxOpt = parseInt(settings.numOptions);
        let hasExceed = settings.matrix.some(r => {
            let targets = parseRangeString(r.range, 999); 
            return targets.some(n => n > maxOpt);
        });
        
        const warningDiv = document.getElementById("cs_matrix_warning");
        if (warningDiv) warningDiv.style.display = hasExceed ? 'block' : 'none';
        
        settings.matrix.forEach((rule, index) => {
            const row = document.createElement('div');
            row.className = "flex-container alignitemscenter flexGap5 marginBot5";
            row.innerHTML = `
                <label>Target Options:</label>
                <input type="text" class="text_pole matrix-range" style="width:70px; text-align:center;" value="${rule.range}" placeholder="1-3" data-idx="${index}">
                <input type="text" class="text_pole matrix-text" style="flex:1" value="${rule.text.replace(/"/g, '&quot;')}" placeholder="Style rule..." data-idx="${index}">
                <div class="menu_button interactable cs-touch-btn matrix-del margin0" style="padding:4px 8px;" data-idx="${index}"><i class="fa-solid fa-trash"></i></div>
            `;
            container.appendChild(row);
        });
        
        $('.matrix-range').on('input', function() { settings.matrix[$(this).data('idx')].range = this.value; updateMatrixUI(); save(); });
        $('.matrix-text').on('input', function() { settings.matrix[$(this).data('idx')].text = this.value; save(); });
        $('.matrix-del').on('click', function() { settings.matrix.splice($(this).data('idx'), 1); updateMatrixUI(); save(); });
    }

    function renderSettingsMenu() {
        if (document.getElementById("cs_active_setting_row")) return true; 
        const target = document.getElementById("extensions_settings") || document.getElementById("extensions_settings2");
        if (!target) return false;

        const html = `
            <div id="cs--settings" class="extension_container">
                <div class="cs-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header cs-drawer-toggle interactable" tabindex="0" role="button">
                        <b>Narrative Choice Stream v${MODULE_VERSION}</b>
                        <div class="inline-drawer-icon fa-solid interactable down fa-circle-chevron-down" tabindex="0" role="button"></div>
                    </div>
                    <div class="cs-drawer-content" style="display: none; padding-top: 10px;">
                        
                        <div id="cs_active_setting_row" class="flex-container marginBot5 justifySpaceBetween">
                            <label class="checkbox_label flex-container" title="Automatically generate choices after AI replies">
                                <input type="checkbox" id="cs_active" ${settings.enabled ? "checked" : ""}>
                                <span>Auto-Gen Choices</span>
                            </label>
                            <label class="checkbox_label flex-container" title="Skip generation if you interrupted the AI">
                                <input type="checkbox" id="cs_skip_interrupt" ${settings.skipInterrupted ? "checked" : ""}>
                                <span>Skip on Interrupt</span>
                            </label>
                            <label class="checkbox_label flex-container" title="Enable Console Logging for debugging Prompts & Outputs">
                                <input type="checkbox" id="cs_debug_mode" ${settings.debugMode ? "checked" : ""}>
                                <span>Console Logging</span>
                            </label>
                        </div>
                        
                        <hr>
                        <h4>Storage & Database Configuration</h4>
                        <div style="font-size:0.8rem; color:#94a3b8; margin-bottom:8px;">Choose where to save your generated history. Server Mode requires running the Installation Script.</div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Storage Engine:</label>
                            <select id="cs_storageMode" class="text_pole" style="flex:1;">
                                <option value="server" ${settings.storageMode === 'server' ? 'selected' : ''}>Server (.jsonl File)</option>
                                <option value="local" ${settings.storageMode === 'local' ? 'selected' : ''}>Local (IndexedDB)</option>
                            </select>
                        </div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;" title="Leave empty to use ST default path">Custom DB Path (Absolute):</label>
                            <input type="text" id="cs_custom_db_path" class="text_pole" style="flex:1;" placeholder="Leave empty for default" value="${settings.custom_db_path}">
                        </div>

                        <hr>
                        <h4>UI Configuration & Resizing</h4>
                        
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Widget Width: <span id="cs_width_val">${settings.widget_width}</span>vw</label>
                            <input type="range" id="cs_width" style="flex:1;" value="${settings.widget_width}" min="30" max="100">
                        </div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Menus Width: <span id="cs_width_modal_val">${settings.modal_width}</span>vw</label>
                            <input type="range" id="cs_width_modal" style="flex:1;" value="${settings.modal_width}" min="50" max="100">
                        </div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;" title="Overall maximum height of the modal">Menus Max Height: <span id="cs_height_modal_val">${settings.modal_height}</span>vh</label>
                            <input type="range" id="cs_height_modal" style="flex:1;" value="${settings.modal_height}" min="50" max="100">
                        </div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;" title="Offsetting the start allows you to place menus lower for easier phone thumb-reach.">Menus Starting Offset (Top): <span id="cs_start_modal_val">${settings.modal_start || 0}</span>vh</label>
                            <input type="range" id="cs_start_modal" style="flex:1;" value="${settings.modal_start || 0}" min="0" max="50">
                        </div>

                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Choices Dock Position</label>
                            <select id="cs_pos" class="text_pole" style="flex:1;">
                                <option value="top" ${settings.position=='top'?'selected':''}>Top (Below Top Bar)</option>
                                <option value="bottom" ${settings.position=='bottom'?'selected':''}>Bottom (Above Input Bar)</option>
                            </select>
                        </div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Choices Max Height: <span id="cs_height_choices_val">${settings.choice_block_max_height}</span>vh</label>
                            <input type="range" id="cs_height_choices" style="flex:1;" value="${settings.choice_block_max_height}" min="20" max="90">
                        </div>
                        
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Vertical Offset (Top): <span id="cs_y_top_val">${settings.offset_top}</span>px</label>
                            <input type="range" id="cs_y_top" style="flex:1;" value="${settings.offset_top}" min="0" max="500">
                        </div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Vertical Offset (Bottom): <span id="cs_y_bot_val">${settings.offset_bottom}</span>px</label>
                            <input type="range" id="cs_y_bot" style="flex:1;" value="${settings.offset_bottom}" min="0" max="500">
                        </div>

                        <hr>
                        <h4>Prompt Engineering</h4>

                        <div class="flex-container alignitemscenter marginBot5" title="Delay API calls by X seconds to prevent crashes.">
                            <label style="flex:1;">API Delay: <span id="cs_delay_val">${settings.generationDelay}</span>s</label>
                            <input type="range" id="cs_delay" style="flex:1;" value="${settings.generationDelay}" min="0" max="15" step="1">
                        </div>
                        
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;"><strong>Number of Options:</strong> <span id="cs_num_val">${settings.numOptions}</span></label>
                            <input type="range" id="cs_num" style="flex:1;" value="${settings.numOptions}" min="1" max="12">
                        </div>

                        <div class="flex-container marginBot5 justifySpaceBetween">
                            <label class="checkbox_label flex-container" title="Inject ST's running summary into the choice generator.">
                                <input type="checkbox" id="cs_include_summary" ${settings.includeSummary ? "checked" : ""}><span>Include Lore</span>
                            </label>
                            <label class="checkbox_label flex-container" title="Automatically structure options using the matrix below.">
                                <input type="checkbox" id="cs_dynamic_matrix" ${settings.dynamicMatrix ? "checked" : ""}><span>Use Matrix</span>
                            </label>
                        </div>
                        
                        <div class="flex-container flexFlowColumn marginBot5" style="border-left: 2px solid var(--SmartThemeBorderColor); padding-left: 10px;">
                            <div class="flex-container alignitemscenter justifySpaceBetween">
                                <label><strong>Option Tone Matrix</strong></label>
                                <div style="display:flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end;">
                                    <div id="cs_export_matrix" class="menu_button interactable cs-touch-btn margin0" tabindex="0" role="button" style="padding: 2px 8px; font-size: 0.85rem;" title="Export Matrix to Clipboard">
                                        <i class="fa-solid fa-copy"></i> Copy
                                    </div>
                                    <div id="cs_export_matrix_file" class="menu_button interactable cs-touch-btn margin0" tabindex="0" role="button" style="padding: 2px 8px; font-size: 0.85rem;" title="Export Matrix to JSON file">
                                        <i class="fa-solid fa-file-export"></i> Export
                                    </div>
                                    <div id="cs_import_matrix" class="menu_button interactable cs-touch-btn margin0" tabindex="0" role="button" style="padding: 2px 8px; font-size: 0.85rem;" title="Import Matrix from Clipboard">
                                        <i class="fa-solid fa-paste"></i> Paste
                                    </div>
                                    <div id="cs_import_matrix_file" class="menu_button interactable cs-touch-btn margin0" tabindex="0" role="button" style="padding: 2px 8px; font-size: 0.85rem;" title="Import Matrix from JSON file">
                                        <i class="fa-solid fa-file-import"></i> Import
                                    </div>
                                    <div id="cs_add_matrix" class="menu_button interactable cs-touch-btn margin0" tabindex="0" role="button" style="padding: 2px 8px; font-size: 0.85rem;">
                                        <i class="fa-solid fa-plus"></i> Add
                                    </div>
                                </div>
                            </div>
                            <div id="cs_matrix_warning" style="color: #ef4444; font-size: 0.85rem; margin-top: 4px; display: none;"><i class="fa-solid fa-triangle-exclamation"></i> Warning: Targets exceed Options.</div>
                            <div id="cs_matrix_list" class="flex-container flexFlowColumn marginTop5"></div>
                        </div>
                        
                        <div class="flex-container flexFlowColumn marginBot5">
                            <div class="flex-container alignitemscenter justifySpaceBetween">
                                <label for="cs_instruction_prompt"><strong>Master Instruction Prompt</strong></label>
                                <div id="cs_reset_prompts" class="menu_button interactable cs-touch-btn margin0" tabindex="0" role="button" title="Restore Default Prompts" style="padding: 2px 8px; font-size: 0.85rem;">
                                    <i class="fa-solid fa-rotate-left"></i> Restore Defaults
                                </div>
                            </div>
                            <textarea id="cs_instruction_prompt" class="text_pole textarea_compact autoSetHeight" rows="8">${settings.instructionPrompt}</textarea>
                        </div>
                        
                        <hr style="border-color: rgba(255,255,255,0.1); margin: 8px 0;">
                        <div class="flex-container marginBot5" style="gap: 5px;">
                            <div id="cs_test" class="menu_button interactable cs-touch-btn flex1 margin0" tabindex="0" role="button">
                                <i class="fa-solid fa-eye"></i> Test UI
                            </div>
                            <div id="cs_manual" class="menu_button interactable cs-touch-btn flex1 margin0" tabindex="0" role="button">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> Force Gen
                            </div>
                            <div id="cs_reset_widget" class="menu_button interactable cs-touch-btn flex1 margin0" tabindex="0" role="button" title="Snap Floating Widget back to Default">
                                <i class="fa-solid fa-arrows-to-dot"></i> Reset Widget Pos
                            </div>
                        </div>
                    </div>
                </div>
            </div>`;
        
        target.insertAdjacentHTML('beforeend', html);

        $("#cs--settings .cs-drawer-toggle").on("click", function(e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const content = $(this).siblings('.cs-drawer-content');
            const icon = $(this).find('.inline-drawer-icon');
            content.slideToggle(200);
            icon.toggleClass('fa-circle-chevron-down fa-circle-chevron-up');
        });

        // Fixed Checkbox Mapping Bug
        const chkMap = {
            'cs_active': 'enabled',
            'cs_skip_interrupt': 'skipInterrupted',
            'cs_debug_mode': 'debugMode',
            'cs_include_summary': 'includeSummary',
            'cs_dynamic_matrix': 'dynamicMatrix'
        };
        for (const [id, key] of Object.entries(chkMap)) {
            $(`#${id}`).on("change", function() {
                settings[key] = this.checked;
                if (id === 'cs_dynamic_matrix') updateMatrixUI();
                save();
            });
        }
        
        $(`#cs_instruction_prompt`).on("input", function() { settings.instructionPrompt = this.value; save(); });
        $(`#cs_custom_db_path`).on("input", function() { settings.custom_db_path = this.value; save(); });
        
        ["cs_num", "cs_delay"].forEach(id => {
            $(`#${id}`).on("input", function() { 
                const key = { "cs_num": "numOptions", "cs_delay": "generationDelay" }[id];
                settings[key] = this.value; 
                if (id === "cs_num") updateMatrixUI();
                $(`#${id}_val`).text(this.value); save(); 
            });
        });

        const sliderMap = {
            "cs_width": ["widget_width", "--cs-panel-width", "vw"],
            "cs_height_choices": ["choice_block_max_height", "--cs-choices-height", "vh"],
            "cs_width_modal": ["modal_width", "--cs-modal-width", "vw"],
            "cs_height_modal": ["modal_height", "--cs-modal-height", "vh"],
            "cs_start_modal": ["modal_start", "--cs-modal-start", "vh"]
        };

        for (const [id, [setKey, cssVar, unit]] of Object.entries(sliderMap)) {
            $(`#${id}`).on("input", function() { 
                settings[setKey] = this.value; 
                $(`#${id}_val`).text(this.value); 
                document.documentElement.style.setProperty(cssVar, this.value + unit);
                save(); 
            });
        }

        $("#cs_storageMode").on("change", function() { settings.storageMode = this.value; save(); });
        $("#cs_y_top").on("input", function() { settings.offset_top = this.value; $("#cs_y_top_val").text(this.value); updateContainerPosition(); save(); });
        $("#cs_y_bot").on("input", function() { settings.offset_bottom = this.value; $("#cs_y_bot_val").text(this.value); updateContainerPosition(); save(); });
        $("#cs_pos").on("change", function() { settings.position = this.value; updateContainerPosition(); save(); });

        $("#cs_test").on("click", (e) => { e.stopPropagation(); triggerGeneration(true); });
        $("#cs_manual").on("click", (e) => { e.stopPropagation(); clearUI(); triggerGeneration(false); });
        
        $("#cs_reset_widget").on("click", (e) => {
            e.stopPropagation();
            settings.widget_left = '40%';
            settings.widget_bottom = '';
            settings.widget_top = '40%';
            const widget = document.getElementById('cs_floating_widget');
            if (widget) {
                widget.style.left = '40%';
                widget.style.top = '40%';
                widget.style.bottom = 'auto';
            }
            save();
            log("Widget position reset.", 1);
        });

        updateMatrixUI();
        
        $("#cs_add_matrix").on("click", (e) => {
            e.stopPropagation();
            settings.matrix.push({ range: "1", text: "New matrix rule" });
            updateMatrixUI();
            save();
        });
        
        $("#cs_export_matrix").on("click", (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(JSON.stringify(settings.matrix, null, 2))
                .then(() => { if (window.toastr) window.toastr.success("Matrix copied to clipboard!", "Export Success"); });
        });

        $("#cs_export_matrix_file").on("click", (e) => {
            e.stopPropagation();
            const blob = new Blob([JSON.stringify(settings.matrix, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.download = `choices_matrix_${Date.now()}.json`;
            a.href = url;
            a.click();
            URL.revokeObjectURL(url);
            if (window.toastr) window.toastr.success("Matrix exported to file!", "Export Success");
        });
        
        $("#cs_import_matrix").on("click", async (e) => {
            e.stopPropagation();
            try {
                const text = await navigator.clipboard.readText();
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].range && parsed[0].text) {
                    settings.matrix = parsed;
                    updateMatrixUI();
                    save();
                    if (window.toastr) window.toastr.success("Matrix imported successfully!", "Import Success");
                } else throw new Error();
            } catch (err) {
                if (window.toastr) window.toastr.error("Invalid matrix format in clipboard.", "Import Failed");
            }
        });

        $("#cs_import_matrix_file").on("click", (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = ev => {
                const file = ev.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = event => {
                    try {
                        const parsed = JSON.parse(event.target.result);
                        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].range && parsed[0].text) {
                            settings.matrix = parsed;
                            updateMatrixUI();
                            save();
                            if (window.toastr) window.toastr.success("Matrix imported from file!", "Import Success");
                        } else throw new Error();
                    } catch (err) {
                        if (window.toastr) window.toastr.error("Invalid matrix format in file.", "Import Failed");
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        });

        $("#cs_reset_prompts").on("click", (e) => {
            e.stopPropagation();
            if(confirm("Restore default JSON prompts?")) {
                settings.instructionPrompt = defaultPrompts.instructionPrompt;
                settings.matrix = JSON.parse(JSON.stringify(defaultPrompts.defaultMatrix));
                $("#cs_instruction_prompt").val(settings.instructionPrompt);
                updateMatrixUI();
                save();
            }
        });
        
        return true;
    }

    function save() {
        const liveContext = getContext();
        liveContext.extensionSettings[MODULE_NAME] = settings;
        if (liveContext.saveSettingsDebounced) liveContext.saveSettingsDebounced();
        updateContainerPosition();
    }

    jQuery(() => { init(); });
})();