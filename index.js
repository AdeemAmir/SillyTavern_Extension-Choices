import {
    eventSource,
    event_types,
    generateQuietPrompt,
    getRequestHeaders
} from '../../../../script.js';

import {
    getContext
} from '../../../extensions.js';

(function () {
    const MODULE_NAME = "SillyTavern_Extension-Choices";
    const context = getContext();
    if (!context) return;

    let isGenerating = false;

    const MD_JSON_START = ['\x60', '\x60', '\x60', 'json'].join('');
    const MD_END = ['\x60', '\x60', '\x60'].join('');
    
    const REGEX_FALLBACK_LIST = /^[-•.*\s\d]+[\.\:\)]?\s+/;

    const defaultPrompts = {
        userStyleTemplate: "### USER STYLE REFERENCE ###\n{{user_messages}}\n#####################",
        instructionPrompt: `[System Note: TASK: Analyze the story context, the summary, and the User Style Reference.\n\n{{style_block}}\n\n{{matrix_block}}\n\nCRITICAL RULES:\n1. Length: Choices MUST be highly detailed, paragraph-length continuations (at least 3 to 5 sentences long).\n2. Content: Include specific immediate actions, rich sensory details, and dialogue. Stay in the immediate present scene. NO time-skips.\n3. JSON Format: Output ONLY a valid JSON array of objects.\n4. Keys: Each object MUST contain EXACTLY ONE key named "choice".\n5. The value of "choice" MUST be the actual narrative paragraph. DO NOT put numbers here. DO NOT add keys for descriptions, reasoning, or titles.\n\nExample format:\n[\n  {"choice": "I slowly back away from the door, my heart hammering against my ribs as the realization sets in. 'We can't stay here,' I whisper, grabbing my coat from the chair. Without waiting for a response, I move to the window, scanning the dark treeline for any sign of movement while frantically trying to piece together a new escape plan."},\n  {"choice": "Another highly detailed narrative paragraph goes here..."}\n]\n\nYou MUST wrap your output in a ${MD_JSON_START} codeblock. Open the codeblock immediately.]`,
        defaultMatrix: [
            { range: "1-2", text: "A highly detailed, logical continuation that realistically advances the current immediate scene." },
            { range: "3-4", text: "A deeply immersive continuation tailored specifically to match the tone, vocabulary, and personality seen in the User Style Reference." },
            { range: "5", text: "A wildcard scenario shift introducing a sudden, unexpected action or detailed dialogue that drastically changes the immediate situation." }
        ]
    };

    let settings = {
        enabled: true,
        includeSummary: true,
        useUserStyle: true,
        dynamicMatrix: true,
        skipInterrupted: true,
        debugMode: 2,           
        numOptions: 5,
        contextDepth: 6,
        generationDelay: 0,     
        layout: "column",
        position: "bottom",
        offset_top: 10,
        offset_bottom: 50,
        
        store_ai_context: true,
        store_summary: true,
        store_user_style: true,
        store_full_prompt: true,
        store_raw_response: true,
        
        widget_width: 90, 
        choice_block_max_height: 40,
        modal_width: 95,
        modal_height: 90,

        userStyleTemplate: defaultPrompts.userStyleTemplate,
        instructionPrompt: defaultPrompts.instructionPrompt,
        matrix: JSON.parse(JSON.stringify(defaultPrompts.defaultMatrix))
    };

    let choiceContainer = null;
    let isInputManuallyEdited = false;
    let lastInsertedText = "";
    let wasInterrupted = false;
    let DOM_textarea = null; 
    let formObserver = null;

    function log(text, level = 1) {
        if (settings.debugMode >= level) {
            console.log(`%c[ST-Choices] ${text}`, level === 2 ? 'color: #8b5cf6;' : 'color: #10b981; font-weight: bold;');
        }
    }

    async function loadSettings() {
        if (context.extensionSettings[MODULE_NAME]) {
            settings = Object.assign(settings, context.extensionSettings[MODULE_NAME]);
            
            // Clean settings.json of bloat if it exists
            if (settings.history || settings.choiceHistory || settings.fails || settings.failedParses || settings.foreverLogText) {
                delete settings.history;
                delete settings.choiceHistory;
                delete settings.fails;
                delete settings.failedParses;
                delete settings.foreverLogText;
                save();
            }
        }
        
        if (!settings.instructionPrompt) settings.instructionPrompt = defaultPrompts.instructionPrompt;
        if (!settings.userStyleTemplate) settings.userStyleTemplate = defaultPrompts.userStyleTemplate;
        if (!settings.matrix) settings.matrix = JSON.parse(JSON.stringify(defaultPrompts.defaultMatrix));
        
        if (settings.widget_width === undefined) settings.widget_width = 90;
        if (settings.choice_block_max_height === undefined) settings.choice_block_max_height = 40;
        if (settings.modal_width === undefined) settings.modal_width = 95;
        if (settings.modal_height === undefined) settings.modal_height = 90;
        
        if (settings.store_ai_context === undefined) settings.store_ai_context = true;
        if (settings.store_summary === undefined) settings.store_summary = true;
        if (settings.store_user_style === undefined) settings.store_user_style = true;
        if (settings.store_full_prompt === undefined) settings.store_full_prompt = true;
        if (settings.store_raw_response === undefined) settings.store_raw_response = true;
        
        applyDynamicCSSVars();
    }

    function applyDynamicCSSVars() {
        document.documentElement.style.setProperty('--cs-panel-width', `${settings.widget_width}vw`);
        document.documentElement.style.setProperty('--cs-modal-width', `${settings.modal_width}vw`);
        document.documentElement.style.setProperty('--cs-modal-height', `${settings.modal_height}vh`);
        document.documentElement.style.setProperty('--cs-choices-height', `${settings.choice_block_max_height}vh`);
    }

    function injectCSS() {
        if (document.getElementById('cs_custom_css')) return;
        const style = document.createElement('style');
        style.id = 'cs_custom_css';
        style.innerHTML = `
            .cs-modal-overlay { position: fixed; inset: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.85); z-index: 999999; display: flex; justify-content: center; align-items: center; padding: 12px; box-sizing: border-box; touch-action: pan-y; backdrop-filter: blur(4px); }
            .cs-modal { position: relative; background: var(--SmartThemeBlurTintColor, #1e1e2e); border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 10px; width: var(--cs-modal-width, 95vw); max-width: 1400px; height: var(--cs-modal-height, 90vh); display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.9); color: var(--SmartThemeBodyColor, #fff); }
            .cs-modal-header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--SmartThemeBorderColor, #444); background: rgba(0,0,0,0.25); gap: 8px; flex-wrap: wrap; }
            .cs-modal-body { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
            .cs-modal-footer { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-top: 1px solid var(--SmartThemeBorderColor, #444); background: rgba(0,0,0,0.25); gap: 10px; }
            
            .cs-touch-btn { touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer; user-select: none; }
            
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
            const chat = context.chat;
            if (chat && chat.length > 0) {
                const lastMsg = chat[chat.length - 1];
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

    // --- IDENTIFICATION LOGIC ---
    function getCurrentChatId() {
        return context.chatId || "Unknown_Chat_ID";
    }

    function getCurrentChatName() {
        if (context.groupId && Array.isArray(context.groups)) {
            const group = context.groups.find(g => g.id === context.groupId || g.uid === context.groupId);
            if (group && group.name) return group.name;
        }
        if (context.characterId !== undefined && Array.isArray(context.characters)) {
            const char = context.characters[context.characterId];
            if (char && char.name) return char.name;
        }
        return context.name2 || "Unknown Chat";
    }

    function extractAIResponseContext() {
        const chat = context.chat;
        if (!chat || chat.length === 0) return "No prior context.";
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system && chat[i].mes) {
                return chat[i].mes;
            }
        }
        return "No AI message found.";
    }

    // --- OFFICIAL SERVER PLUGIN API HOOKS ---
    function getApiHeaders() {
        let headers = { 'Content-Type': 'application/json' };
        try {
            if (typeof getRequestHeaders === 'function') {
                Object.assign(headers, getRequestHeaders());
            }
        } catch (e) {
            const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
            headers['X-CSRF-Token'] = token;
        }
        return headers;
    }
    
    async function apiGetDB() {
        try {
            return await $.ajax({
                url: '/api/plugins/st_choices_backend/db',
                type: 'GET',
                headers: getApiHeaders(),
                dataType: 'json'
            });
        } catch (e) {
            if (e.status === 404) {
                if(window.toastr) window.toastr.error("Choice Stream database not found! Ensure st_choices_backend is correctly placed in plugins/ and you restarted ST.", "Backend Error", {timeOut: 8000});
            } else {
                if(window.toastr) window.toastr.error("DB Fetch Error: " + e.statusText, "Choice Stream");
            }
            log("API Fetch Error: " + e.responseText, 1);
            return [];
        }
    }

    async function apiLogEvent(payload) {
        try {
            await $.ajax({
                url: '/api/plugins/st_choices_backend/log',
                type: 'POST',
                headers: getApiHeaders(),
                contentType: 'application/json',
                data: JSON.stringify(payload)
            });
        } catch (e) {
            if (e.status === 404) {
                if(window.toastr) window.toastr.error("Cannot save choices! Backend is missing. Ensure the backend folder is in plugins/.", "Extension Setup Error");
            }
            log("API Log Error: " + e.responseText, 1);
        }
    }

    async function apiDeleteRecord(global_id) {
        try {
            await $.ajax({
                url: '/api/plugins/st_choices_backend/delete',
                type: 'POST',
                headers: getApiHeaders(),
                contentType: 'application/json',
                data: JSON.stringify({ global_id: Number(global_id) })
            });
        } catch (e) {
            if(window.toastr) window.toastr.error("Failed to delete record.", "Choice Stream");
        }
    }

    async function apiClearDB(type = "ALL") {
        try {
            await $.ajax({
                url: '/api/plugins/st_choices_backend/clear',
                type: 'POST',
                headers: getApiHeaders(),
                contentType: 'application/json',
                data: JSON.stringify({ type })
            });
        } catch (e) {
            if(window.toastr) window.toastr.error("Failed to wipe database.", "Choice Stream");
        }
    }

    async function downloadDatasetJSON() {
        const logs = await apiGetDB();
        if (!logs || logs.length === 0) return alert("No log data available to download.");
        
        const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.download = `st_choices_dataset_${Date.now()}.json`;
        a.href = url;
        a.click();
        URL.revokeObjectURL(url);
    }

    function bindTapClose(element, callback) {
        if (!element) return;
        let touched = false;
        element.addEventListener('touchend', (e) => {
            touched = true;
            e.preventDefault();
            e.stopPropagation();
            callback();
        }, { passive: false });
        element.addEventListener('click', (e) => {
            if (touched) { touched = false; return; }
            e.preventDefault();
            e.stopPropagation();
            callback();
        });
    }

    // --- MODALS ---
    async function showHistoryModal(filterChat = "__ALL__", searchKeyword = "") {
        if (document.getElementById('cs_history_modal')) document.getElementById('cs_history_modal').remove();
        
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'cs_history_modal';
        modalOverlay.className = 'cs-modal-overlay';
        
        const currentChatId = getCurrentChatId();
        let allRecords = await apiGetDB();
        
        let allClusters = allRecords.filter(r => r.status === "SUCCESS");
        allClusters.sort((a,b) => b.timestamp - a.timestamp);
        
        const chatKeysMap = {};
        allClusters.forEach(c => chatKeysMap[c.chat_id] = c.chat_name);

        let filtered = allClusters;
        if (filterChat !== "__ALL__") {
            filtered = filtered.filter(c => c.chat_id === filterChat);
        }
        if (searchKeyword.trim() !== "") {
            const kw = searchKeyword.toLowerCase();
            filtered = filtered.filter(c => 
                (c.chat_name && c.chat_name.toLowerCase().includes(kw)) || 
                (c.choices && c.choices.some(choice => choice.toLowerCase().includes(kw))) ||
                (c.custom_direction && c.custom_direction.toLowerCase().includes(kw)) ||
                (c.ai_context && c.ai_context.toLowerCase().includes(kw))
            );
        }

        let chatOptionsHtml = `<option value="__ALL__" ${filterChat === '__ALL__' ? 'selected' : ''}>All Chats (${allClusters.length} total saves)</option>`;
        const chatKeysArr = Object.keys(chatKeysMap).sort((a,b) => a === currentChatId ? -1 : (b === currentChatId ? 1 : chatKeysMap[a].localeCompare(chatKeysMap[b])));
        
        chatKeysArr.forEach(chatId => {
            const isCurr = chatId === currentChatId ? '★ [Current] ' : '';
            const count = allClusters.filter(c => c.chat_id === chatId).length;
            const cName = chatKeysMap[chatId] || chatId;
            chatOptionsHtml += `<option value="${chatId}" ${filterChat === chatId ? 'selected' : ''}>${isCurr}${cName} (${count})</option>`;
        });

        let bodyHtml = "";
        if (filtered.length === 0) {
            bodyHtml = `<div style="text-align:center; padding: 40px 10px; color: rgba(255,255,255,0.4);">No saved choice history matches the criteria.</div>`;
        } else {
            filtered.forEach(cluster => {
                const totalWords = cluster.choices.reduce((acc, c) => acc + (c.trim() ? c.trim().split(/\s+/).length : 0), 0);
                const totalChars = cluster.choices.reduce((acc, c) => acc + c.length, 0);
                const estTokens = Math.round(totalWords * 1.3);

                bodyHtml += `
                    <div class="cs-history-cluster" data-id="${cluster.global_id}">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:6px;">
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <div style="font-weight:bold; font-size:0.95rem; color:#a78bfa;">
                                    ${cluster.chat_name} 
                                    ${cluster.chat_id === currentChatId ? '<span style="color:#10b981; font-size:0.75rem; font-weight:normal;">(Active Chat)</span>' : ''}
                                </div>
                                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                    <span class="cs-stat-pill" title="Global DB ID">ID: ${cluster.global_id}</span>
                                    <span class="cs-stat-pill" title="Chat-Specific Generation ID">Chat#: ${cluster.chat_num}</span>
                                    <span class="cs-stat-pill"><i class="fa-solid fa-clock"></i> ${cluster.datetime}</span>
                                    <span class="cs-stat-pill" style="color:#38bdf8;"><i class="fa-solid fa-list-ol"></i> ${cluster.choices.length} options</span>
                                    <span class="cs-stat-pill"><i class="fa-solid fa-font"></i> ${totalWords}w / ${totalChars}c</span>
                                </div>
                                ${cluster.custom_direction ? `<div style="font-size:0.8rem; color:#f472b6;"><b>Prompt:</b> "${cluster.custom_direction}"</div>` : ''}
                            </div>
                            <div style="display:flex; gap:8px;">
                                <button class="menu_button cs-touch-btn cs-load-cluster-btn margin0" style="padding:4px 8px; font-size:0.8rem; color:#10b981;" title="Load into choices UI"><i class="fa-solid fa-arrow-up-right-from-square"></i> Use</button>
                                <button class="menu_button cs-touch-btn cs-del-cluster-btn margin0" style="padding:4px 8px; font-size:0.8rem; color:#ef4444;" title="Delete this cluster"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>

                        ${cluster.ai_context ? `
                        <div style="font-size: 0.82rem; color: #cbd5e1; margin-top: 6px; margin-bottom: 6px; font-style: italic; border-left: 2px solid #64748b; padding-left: 6px;">
                            ${cluster.ai_context.substring(0, 150)}${cluster.ai_context.length > 150 ? '...' : ''}
                        </div>` : ''}

                        <div class="cs-cluster-preview" style="font-size:0.88rem; opacity:0.85; cursor:pointer;">
                            ${cluster.choices.map((c, i) => `<div><span style="color:#8b5cf6;">[${i+1}]</span> ${c.substring(0, 110)}...</div>`).join('')}
                        </div>

                        <div class="cs-toggle-inspect" style="font-size:0.8rem; color:#8b5cf6; cursor:pointer; text-decoration:underline;">
                            <i class="fa-solid fa-chevron-down"></i> Inspect Full Options & Context
                        </div>

                        <div class="cs-cluster-details">
                            ${cluster.ai_context ? `
                            <div style="font-size:0.8rem; background:rgba(0,0,0,0.3); padding:8px; border-radius:4px; border-left:3px solid #8b5cf6;">
                                <b style="color:#a78bfa;">AI Context Snippet:</b>
                                <div style="margin-top:4px; max-height:80px; overflow-y:auto; opacity:0.85;">${cluster.ai_context.replace(/</g, '&lt;')}</div>
                            </div>` : ''}
                            
                            ${cluster.choices.map((c, i) => {
                                const w = c.trim().split(/\s+/).length;
                                return `
                                    <div class="cs-single-option">
                                        <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:0.8rem; color:#94a3b8;">
                                            <span><b>Option ${i+1}</b> (${w} words, ${c.length} chars)</span>
                                            <div style="display:flex; gap:6px;">
                                                <button class="cs-copy-single-btn menu_button cs-touch-btn margin0" data-text="${encodeURIComponent(c)}" style="padding:2px 6px; font-size:0.75rem;"><i class="fa-solid fa-copy"></i> Copy</button>
                                                <button class="cs-insert-single-btn menu_button cs-touch-btn margin0" data-text="${encodeURIComponent(c)}" style="padding:2px 6px; font-size:0.75rem; color:#10b981;"><i class="fa-solid fa-pen-to-square"></i> Send to Input</button>
                                            </div>
                                        </div>
                                        <div>${c.replace(/</g, '&lt;')}</div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            });
        }

        modalOverlay.innerHTML = `
            <div class="cs-modal">
                <div class="cs-modal-header">
                    <span style="font-size:1.1rem;"><i class="fa-solid fa-clock-rotate-left"></i> Choice Database</span>
                    <div style="display:flex; gap:8px;">
                        <button id="cs_hist_download_btn" class="menu_button cs-touch-btn margin0" title="Export Dataset to JSON"><i class="fa-solid fa-file-export"></i> Dataset</button>
                        <button id="cs_hist_clearall_btn" class="menu_button cs-touch-btn margin0" style="color:#ef4444;"><i class="fa-solid fa-trash"></i> Wipe</button>
                        <button id="cs_hist_head_close" class="menu_button cs-touch-btn margin0" style="background:rgba(239,68,68,0.2);"><i class="fa-solid fa-xmark"></i> Close</button>
                    </div>
                </div>

                <div style="padding:10px 12px; flex:0 0 auto;">
                    <div class="cs-filter-bar">
                        <select id="cs_hist_chat_select" class="text_pole" style="flex:1; min-width:180px;">${chatOptionsHtml}</select>
                        <input type="text" id="cs_hist_search_input" class="text_pole" placeholder="Search keywords..." value="${searchKeyword}" style="flex:1; min-width:140px;">
                    </div>
                </div>

                <div class="cs-modal-body">${bodyHtml}</div>

                <div class="cs-modal-footer">
                    <div style="font-size:0.85rem; color:#94a3b8;">Showing <b>${filtered.length}</b> of <b>${allClusters.length}</b> clusters</div>
                    <button id="cs_hist_foot_close" class="menu_button cs-touch-btn margin0" style="min-width:100px; font-weight:bold;"><i class="fa-solid fa-check"></i> Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalOverlay);

        const closeModal = () => modalOverlay.remove();
        bindTapClose(document.getElementById('cs_hist_head_close'), closeModal);
        bindTapClose(document.getElementById('cs_hist_foot_close'), closeModal);
        modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

        $('#cs_hist_chat_select').on('change', function() {
            showHistoryModal(this.value, $('#cs_hist_search_input').val());
        });
        $('#cs_hist_search_input').on('input', function() {
            const val = this.value;
            clearTimeout(window.__cs_search_timer);
            window.__cs_search_timer = setTimeout(() => {
                showHistoryModal($('#cs_hist_chat_select').val(), val);
            }, 300);
        });

        modalOverlay.querySelectorAll('.cs-toggle-inspect').forEach(el => {
            el.onclick = () => {
                const details = el.nextElementSibling;
                const isOpen = details.style.display === 'flex';
                details.style.display = isOpen ? 'none' : 'flex';
                el.innerHTML = isOpen 
                    ? '<i class="fa-solid fa-chevron-down"></i> Inspect Full Options & Context'
                    : '<i class="fa-solid fa-chevron-up"></i> Hide Full Options';
            };
        });

        modalOverlay.querySelectorAll('.cs-load-cluster-btn').forEach(btn => {
            btn.onclick = () => {
                const parent = btn.closest('.cs-history-cluster');
                const id = Number(parent.getAttribute('data-id'));
                const cluster = filtered.find(c => c.global_id === id);
                if (cluster) renderChoices(cluster.choices);
                closeModal();
            };
        });

        modalOverlay.querySelectorAll('.cs-del-cluster-btn').forEach(btn => {
            btn.onclick = async () => {
                const parent = btn.closest('.cs-history-cluster');
                const id = Number(parent.getAttribute('data-id'));
                await apiDeleteRecord(id);
                showHistoryModal($('#cs_hist_chat_select').val(), $('#cs_hist_search_input').val());
            };
        });

        modalOverlay.querySelectorAll('.cs-copy-single-btn').forEach(btn => {
            btn.onclick = () => {
                const text = decodeURIComponent(btn.getAttribute('data-text'));
                navigator.clipboard.writeText(text).then(() => {
                    const oldHtml = btn.innerHTML;
                    btn.innerHTML = `<i class="fa-solid fa-check"></i> Copied!`;
                    btn.style.color = '#10b981';
                    setTimeout(() => { btn.innerHTML = oldHtml; btn.style.color = ''; }, 1500);
                });
            };
        });

        modalOverlay.querySelectorAll('.cs-insert-single-btn').forEach(btn => {
            btn.onclick = () => {
                const text = decodeURIComponent(btn.getAttribute('data-text'));
                if (!DOM_textarea) DOM_textarea = document.getElementById("send_textarea");
                if (DOM_textarea) {
                    DOM_textarea.value = text;
                    lastInsertedText = text;
                    DOM_textarea.dispatchEvent(new Event("input", { bubbles: true }));
                    DOM_textarea.focus();
                }
                closeModal();
            };
        });

        document.getElementById('cs_hist_download_btn').onclick = downloadDatasetJSON;
        document.getElementById('cs_hist_clearall_btn').onclick = async () => {
            if (confirm("WARNING: This will permanently delete ALL successful choice history records.\n\nProceed?")) {
                if (confirm("SECOND CONFIRMATION:\n\nAre you absolutely sure? This will instantly wipe the data from your database file and CANNOT be undone.")) {
                    await apiClearDB("SUCCESS");
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
        
        let allRecords = await apiGetDB();
        const fails = allRecords.filter(r => r.status === "FAIL");
        fails.sort((a,b) => b.timestamp - a.timestamp);

        let bodyHtml = "";
        if (fails.length === 0) {
            bodyHtml = `<div style="text-align:center; padding: 40px 10px; color: rgba(255,255,255,0.4);">No unparsed LLM responses recorded. Everything is parsing smoothly!</div>`;
        } else {
            fails.forEach(fail => {
                const wordCount = (fail.raw_response || "").trim().split(/\s+/).length;
                bodyHtml += `
                    <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.07); border-radius:6px; padding:10px;">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
                            <div>
                                <b style="color:#ef4444;">${fail.chat_name}</b>
                                <div style="display:flex; gap:6px; margin-top:3px; flex-wrap:wrap;">
                                    <span class="cs-stat-pill" title="Global DB ID">ID: ${fail.global_id}</span>
                                    <span class="cs-stat-pill">${fail.datetime}</span>
                                    <span class="cs-stat-pill">${wordCount} words / ${(fail.raw_response || "").length} chars</span>
                                </div>
                            </div>
                            <div style="display:flex; gap:8px;">
                                <button class="menu_button cs-touch-btn cs-fail-copy-btn margin0" data-text="${encodeURIComponent(fail.raw_response || '')}"><i class="fa-solid fa-copy"></i> Copy Raw</button>
                                <button class="menu_button cs-touch-btn cs-fail-del-btn margin0" data-id="${fail.global_id}" style="color:#ef4444;"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>

                        ${fail.ai_context ? `
                        <div style="font-size: 0.82rem; color: #cbd5e1; margin-bottom: 8px; font-style: italic; border-left: 2px solid #ef4444; padding-left: 6px;">
                            <b>Failed context snippet:</b> "${fail.ai_context.substring(0, 150)}${fail.ai_context.length > 150 ? '...' : ''}"
                        </div>` : ''}

                        <div class="cs-failed-item">${(fail.raw_response || "").replace(/</g, '&lt;')}</div>
                    </div>
                `;
            });
        }

        modalOverlay.innerHTML = `
            <div class="cs-modal">
                <div class="cs-modal-header">
                    <span style="font-size:1.1rem;"><i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i> Unparsed Raw Responses (${fails.length})</span>
                    <div style="display:flex; gap:8px;">
                        <button id="cs_fail_clearall_btn" class="menu_button cs-touch-btn margin0" style="color:#ef4444;"><i class="fa-solid fa-trash"></i> Clear All</button>
                        <button id="cs_fail_head_close" class="menu_button cs-touch-btn margin0" style="background:rgba(239,68,68,0.2);"><i class="fa-solid fa-xmark"></i> Close</button>
                    </div>
                </div>

                <div class="cs-modal-body">${bodyHtml}</div>

                <div class="cs-modal-footer">
                    <div style="font-size:0.85rem; color:#94a3b8;">Copy readable sections directly into your story.</div>
                    <button id="cs_fail_foot_close" class="menu_button cs-touch-btn margin0" style="min-width:100px; font-weight:bold;"><i class="fa-solid fa-check"></i> Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalOverlay);

        const closeModal = () => modalOverlay.remove();
        bindTapClose(document.getElementById('cs_fail_head_close'), closeModal);
        bindTapClose(document.getElementById('cs_fail_foot_close'), closeModal);
        modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

        modalOverlay.querySelectorAll('.cs-fail-copy-btn').forEach(btn => {
            btn.onclick = () => {
                const text = decodeURIComponent(btn.getAttribute('data-text'));
                navigator.clipboard.writeText(text).then(() => {
                    const oldHtml = btn.innerHTML;
                    btn.innerHTML = `<i class="fa-solid fa-check"></i> Copied!`;
                    btn.style.color = '#10b981';
                    setTimeout(() => { btn.innerHTML = oldHtml; btn.style.color = ''; }, 1500);
                });
            };
        });

        modalOverlay.querySelectorAll('.cs-fail-del-btn').forEach(btn => {
            btn.onclick = async () => {
                const id = Number(btn.getAttribute('data-id'));
                await apiDeleteRecord(id);
                showFailedModal();
            };
        });

        document.getElementById('cs_fail_clearall_btn').onclick = async () => {
            if (confirm("WARNING: This will permanently delete ALL failed parse records.\n\nProceed?")) {
                if (confirm("SECOND CONFIRMATION:\n\nAre you sure you want to wipe the fails database? This CANNOT be undone.")) {
                    await apiClearDB("FAIL");
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
                if (e.type === 'touchend' && e.cancelable) {
                    e.preventDefault(); 
                }
                
                if (panel.classList.contains('is-open')) {
                    panel.classList.remove('is-open');
                    input.blur();
                } else {
                    panel.classList.add('is-open');
                    setTimeout(() => input.focus(), 15); 
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

    function getResolvedMatrix(maxOptions, bypass = false) {
        if (bypass) return []; 
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
                let ruleText = rule.text;
                if (!settings.useUserStyle) {
                    ruleText = ruleText.replace(/the User Style Reference/gi, "the current narrative tone and context");
                    ruleText = ruleText.replace(/User Style Reference/gi, "the narrative tone");
                }
                resolvedRules.push({ targets: targets, text: ruleText });
            }
        });
        return resolvedRules;
    }

    function buildMatrixPrompt(hasCustomDirection = false) {
        let maxOptions = parseInt(settings.numOptions);
        let resolvedRules = getResolvedMatrix(maxOptions, hasCustomDirection);
        
        if (resolvedRules.length === 0) {
            return `Generate exactly ${maxOptions} distinct action/dialogue choices for {{user}}.\n`;
        }
        
        let matrixStr = `Generate exactly ${maxOptions} distinct action/dialogue choices for {{user}} following this precise matrix:\n`;
        resolvedRules.forEach(rule => {
            let targetsStr = rule.targets.length === 1 ? rule.targets[0].toString() : rule.targets.join(', ');
            matrixStr += `- Option${rule.targets.length > 1 ? 's' : ''} ${targetsStr}: ${rule.text}\n`;
        });
        return matrixStr.trim();
    }

    function extractStorySummary() {
        if (!settings.includeSummary) return "";
        const chat = context.chat;
        if (!chat || chat.length === 0) return "";

        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_system && chat[i].mes && (chat[i].mes.includes("Summary:") || chat[i].mes.includes("<memory>"))) {
                return `### STORY SUMMARY ###\n${chat[i].mes.trim()}`;
            }
        }
        if (context.extensionSettings?.memory?.summary) {
            return `### STORY SUMMARY ###\n${context.extensionSettings.memory.summary}`;
        }
        return "";
    }

    function buildUserStyleProfile() {
        if (!settings.useUserStyle) return "";
        const chat = context.chat;
        if (!chat || chat.length === 0) return "";
        
        const userMsgs = chat.slice(-15)
            .filter(msg => msg.is_user && !msg.is_system && !msg.mes.startsWith('/'))
            .map(msg => msg.mes.trim());
            
        if (userMsgs.length === 0) return "";
        const styleString = userMsgs.slice(-3).join('\n---\n');
        return settings.userStyleTemplate.replaceAll("{{user_messages}}", styleString);
    }

    async function triggerGeneration(isTest = false, customDirection = "") {
        if (isGenerating) {
            log("Generation already in progress. Ignoring duplicate request.", 1);
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

        const chat = context.chat;
        if (!chat?.length || chat[chat.length - 1].is_user) {
            log("Cannot generate choices: Last message in chat is from the user.", 2);
            if (window.toastr) window.toastr.warning("You must wait for the character to reply before generating choices.", "Generation Blocked");
            if (goBtnIcon) goBtnIcon.className = "fa-solid fa-play";
            return;
        }

        isGenerating = true;
        const storySummary = extractStorySummary();
        const userStyle = buildUserStyleProfile();
        const dynamicMatrix = buildMatrixPrompt(false);
        let compiledPrompt = "";
        let rawResponse = "";
        let choices = [];
        let isSuccess = false;
        
        try {
            log(`Fetching ${settings.numOptions} choices from Native backend...`, 1);
            
            let safeUserName = context.name2 || "The Player";
            if (safeUserName === "SillyTavern System" || safeUserName === "System") safeUserName = "The Player";

            let stInstruction = settings.instructionPrompt
                .replaceAll("{{numOptions}}", settings.numOptions)
                .replaceAll("{{style_block}}", userStyle)
                .replaceAll("{{matrix_block}}", dynamicMatrix)
                .replaceAll("{{user}}", safeUserName);

            if (customDirection && customDirection.trim() !== "") {
                const dirPrompt = `\n=====\nTARGET NARRATIVE DIRECTION\nALL choices MUST strictly execute or revolve around this specific intent: "${customDirection.trim()}"\nDO NOT deviate from this core premise!\n=====\n`;
                if (stInstruction.includes("CRITICAL RULES")) {
                    stInstruction = stInstruction.replace("CRITICAL RULES", `${dirPrompt}\nCRITICAL RULES`);
                } else {
                    if (stInstruction.endsWith("]")) stInstruction = stInstruction.slice(0, -1) + `\n${dirPrompt}]`;
                    else stInstruction += `\n${dirPrompt}`;
                }
            }

            compiledPrompt = storySummary ? `${storySummary}\n\n${stInstruction}` : stInstruction;
            
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
                const payload = {
                    datetime: new Date().toLocaleString(),
                    timestamp: Date.now(),
                    chat_id: getCurrentChatId(),
                    chat_name: getCurrentChatName(),
                    status: isSuccess ? "SUCCESS" : "FAIL",
                    ai_context: settings.store_ai_context ? extractAIResponseContext() : "",
                    story_summary: settings.store_summary ? storySummary : "",
                    user_style: settings.store_user_style ? userStyle : "",
                    custom_direction: customDirection.trim(),
                    full_prompt: settings.store_full_prompt ? compiledPrompt : "",
                    raw_response: settings.store_raw_response ? rawResponse : "",
                    choices: isSuccess ? choices : []
                };

                apiLogEvent(payload);
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
        if (document.getElementById("cs_active")) return true; 
        const target = document.getElementById("extensions_settings") || document.getElementById("extensions_settings2");
        if (!target) return false;

        const html = `
            <div id="cs--settings" class="extension_container">
                <div class="cs-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header cs-drawer-toggle interactable" tabindex="0" role="button">
                        <b>Narrative Choice Stream</b>
                        <div class="inline-drawer-icon fa-solid interactable down fa-circle-chevron-down" tabindex="0" role="button"></div>
                    </div>
                    <div class="cs-drawer-content" style="display: none; padding-top: 10px;">
                        
                        <div class="flex-container marginBot5 justifySpaceBetween">
                            <label class="checkbox_label flex-container">
                                <input type="checkbox" id="cs_active" ${settings.enabled ? "checked" : ""}>
                                <span>Auto-generate Choices</span>
                            </label>
                            <label class="checkbox_label flex-container">
                                <input type="checkbox" id="cs_skip_interrupt" ${settings.skipInterrupted ? "checked" : ""}>
                                <span>Skip on Interrupt</span>
                            </label>
                        </div>
                        
                        <hr>
                        <h4>Data Logging & Machine Learning</h4>
                        <div style="font-size:0.8rem; color:#94a3b8; margin-bottom:8px;">Select which metadata to include in the DB for future AI training/analysis.</div>
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px;">
                            <label class="checkbox_label flex-container"><input type="checkbox" id="cs_store_ai_context" ${settings.store_ai_context ? "checked" : ""}><span>AI Context</span></label>
                            <label class="checkbox_label flex-container"><input type="checkbox" id="cs_store_summary" ${settings.store_summary ? "checked" : ""}><span>Story Summary</span></label>
                            <label class="checkbox_label flex-container"><input type="checkbox" id="cs_store_user_style" ${settings.store_user_style ? "checked" : ""}><span>User Style</span></label>
                            <label class="checkbox_label flex-container"><input type="checkbox" id="cs_store_full_prompt" ${settings.store_full_prompt ? "checked" : ""}><span>Full Prompt</span></label>
                            <label class="checkbox_label flex-container"><input type="checkbox" id="cs_store_raw_response" ${settings.store_raw_response ? "checked" : ""}><span>Raw Response</span></label>
                        </div>
                        
                        <hr>
                        <h4>UI Configuration & Resizing</h4>
                        
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Widget Width: <span id="cs_width_val">${settings.widget_width}</span>vw</label>
                            <input type="range" id="cs_width" style="flex:1;" value="${settings.widget_width}" min="30" max="100">
                        </div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Choices Max Height: <span id="cs_height_choices_val">${settings.choice_block_max_height}</span>vh</label>
                            <input type="range" id="cs_height_choices" style="flex:1;" value="${settings.choice_block_max_height}" min="20" max="90">
                        </div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Menus Width: <span id="cs_width_modal_val">${settings.modal_width}</span>vw</label>
                            <input type="range" id="cs_width_modal" style="flex:1;" value="${settings.modal_width}" min="50" max="100">
                        </div>
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Menus Height: <span id="cs_height_modal_val">${settings.modal_height}</span>vh</label>
                            <input type="range" id="cs_height_modal" style="flex:1;" value="${settings.modal_height}" min="50" max="100">
                        </div>

                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Dock Position</label>
                            <select id="cs_pos" class="text_pole" style="flex:1;">
                                <option value="top" ${settings.position=='top'?'selected':''}>Top (Below Top Bar)</option>
                                <option value="bottom" ${settings.position=='bottom'?'selected':''}>Bottom (Above Input Bar)</option>
                            </select>
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
                            <input type="range" id="cs_num" style="flex:1;" value="${settings.numOptions}" min="1" max="10">
                        </div>

                        <div class="flex-container marginBot5 justifySpaceBetween">
                            <label class="checkbox_label flex-container" title="Inject ST's running summary into the choice generator.">
                                <input type="checkbox" id="cs_include_summary" ${settings.includeSummary ? "checked" : ""}><span>Include Lore</span>
                            </label>
                            <label class="checkbox_label flex-container" title="Extract past messages to teach the LLM your writing style.">
                                <input type="checkbox" id="cs_use_user_style" ${settings.useUserStyle ? "checked" : ""}><span>Enable Profile</span>
                            </label>
                            <label class="checkbox_label flex-container" title="Automatically structure options using the matrix below.">
                                <input type="checkbox" id="cs_dynamic_matrix" ${settings.dynamicMatrix ? "checked" : ""}><span>Use Matrix</span>
                            </label>
                        </div>
                        
                        <div class="flex-container flexFlowColumn marginBot5" style="border-left: 2px solid var(--SmartThemeBorderColor); padding-left: 10px;">
                            <div class="flex-container alignitemscenter justifySpaceBetween">
                                <label><strong>Option Tone Matrix</strong></label>
                                <div id="cs_add_matrix" class="menu_button interactable cs-touch-btn margin0" tabindex="0" role="button" style="padding: 2px 8px; font-size: 0.85rem;">
                                    <i class="fa-solid fa-plus"></i> Add Rule
                                </div>
                            </div>
                            <div id="cs_matrix_warning" style="color: #ef4444; font-size: 0.85rem; margin-top: 4px; display: none;"><i class="fa-solid fa-triangle-exclamation"></i> Warning: Targets exceed Options.</div>
                            <div id="cs_matrix_list" class="flex-container flexFlowColumn marginTop5"></div>
                        </div>

                        <div class="flex-container flexFlowColumn marginBot5">
                            <label for="cs_user_style_template"><strong>User Style Block Template</strong></label>
                            <textarea id="cs_user_style_template" class="text_pole textarea_compact autoSetHeight" rows="3">${settings.userStyleTemplate}</textarea>
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

        const chkMap = ['cs_active', 'cs_skip_interrupt', 'cs_include_summary', 'cs_use_user_style', 'cs_dynamic_matrix', 'cs_store_ai_context', 'cs_store_summary', 'cs_store_user_style', 'cs_store_full_prompt', 'cs_store_raw_response'];
        chkMap.forEach(id => {
            $(`#${id}`).on("change", function() { 
                const key = id.replace("cs_", "");
                settings[key] = this.checked; 
                if (id === 'cs_use_user_style' || id === 'cs_dynamic_matrix') updateMatrixUI(); 
                save(); 
            });
        });
        
        $(`#cs_instruction_prompt`).on("input", function() { settings.instructionPrompt = this.value; save(); });
        $(`#cs_user_style_template`).on("input", function() { settings.userStyleTemplate = this.value; save(); });
        
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
            "cs_height_modal": ["modal_height", "--cs-modal-height", "vh"]
        };

        for (const [id, [setKey, cssVar, unit]] of Object.entries(sliderMap)) {
            $(`#${id}`).on("input", function() { 
                settings[setKey] = this.value; 
                $(`#${id}_val`).text(this.value); 
                document.documentElement.style.setProperty(cssVar, this.value + unit);
                save(); 
            });
        }

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

        $("#cs_reset_prompts").on("click", (e) => {
            e.stopPropagation();
            if(confirm("Restore default JSON prompts?")) {
                settings.instructionPrompt = defaultPrompts.instructionPrompt;
                settings.userStyleTemplate = defaultPrompts.userStyleTemplate;
                settings.matrix = JSON.parse(JSON.stringify(defaultPrompts.defaultMatrix));
                $("#cs_instruction_prompt").val(settings.instructionPrompt);
                $("#cs_user_style_template").val(settings.userStyleTemplate);
                updateMatrixUI();
                save();
            }
        });
        
        return true;
    }

    function save() {
        context.extensionSettings[MODULE_NAME] = settings;
        if (context.saveSettingsDebounced) context.saveSettingsDebounced();
        updateContainerPosition();
    }

    jQuery(() => { init(); });
})();