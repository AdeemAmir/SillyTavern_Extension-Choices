import {
    eventSource,
    event_types,
    generateQuietPrompt
} from '../../../../script.js';

import {
    getContext
} from '../../../extensions.js';

(function () {
    const MODULE_NAME = "st_choice_stream";
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
        widget_left: '40%',
        widget_top: '40%',
        widget_bottom: '',
        widget_width: 90, 
        userStyleTemplate: defaultPrompts.userStyleTemplate,
        instructionPrompt: defaultPrompts.instructionPrompt,
        matrix: JSON.parse(JSON.stringify(defaultPrompts.defaultMatrix)),
        choiceHistory: {},
        failedParses: [],
        foreverLogText: ""
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

    function loadSettings() {
        if (context.extensionSettings[MODULE_NAME]) {
            settings = Object.assign(settings, context.extensionSettings[MODULE_NAME]);
            if (!settings.instructionPrompt) settings.instructionPrompt = defaultPrompts.instructionPrompt;
            if (!settings.userStyleTemplate) settings.userStyleTemplate = defaultPrompts.userStyleTemplate;
            if (!settings.matrix) settings.matrix = JSON.parse(JSON.stringify(defaultPrompts.defaultMatrix));
            if (!settings.widget_left) settings.widget_left = '40%';
            if (!settings.widget_top && !settings.widget_bottom) settings.widget_top = '40%';
            if (settings.widget_width === undefined) settings.widget_width = 90;
            if (!settings.choiceHistory) settings.choiceHistory = {};
            if (!settings.failedParses) settings.failedParses = [];
            if (!settings.foreverLogText) settings.foreverLogText = "";
        }
        document.documentElement.style.setProperty('--cs-panel-width', `${settings.widget_width}vw`);
    }

    function injectCSS() {
        if (document.getElementById('cs_custom_css')) return;
        const style = document.createElement('style');
        style.id = 'cs_custom_css';
        style.innerHTML = `
            .cs-modal-overlay { position: fixed; inset: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.85); z-index: 999999; display: flex; justify-content: center; align-items: center; padding: 12px; box-sizing: border-box; touch-action: pan-y; backdrop-filter: blur(4px); }
            .cs-modal { position: relative; background: var(--SmartThemeBlurTintColor, #1e1e2e); border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 10px; width: 100%; max-width: 680px; height: 90vh; max-height: 850px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.9); color: var(--SmartThemeBodyColor, #fff); }
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
        log("Booting Concurrency-Locked Matrix Engine...", 1);
        loadSettings();
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

    // --- LOGGING & HISTORY MANAGEMENT ---

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

    function saveToHistory(choices, customDirection = "") {
        const chatName = context.chatId || context.name2 || "Unknown_Chat";
        const aiResponse = extractAIResponseContext();
        const timestamp = Date.now();
        
        if (!settings.choiceHistory[chatName]) settings.choiceHistory[chatName] = [];
        
        const entry = { timestamp, aiResponse, choices, direction: customDirection.trim() };
        settings.choiceHistory[chatName].unshift(entry);
        
        if (!settings.foreverLogText) settings.foreverLogText = "";
        let logEntry = `\n=================================\n`;
        logEntry += `DATE: ${new Date(timestamp).toLocaleString()}\n`;
        logEntry += `CHAT: ${chatName}\n`;
        if (customDirection.trim()) logEntry += `CUSTOM DIRECTION: "${customDirection.trim()}"\n`;
        logEntry += `AI CONTEXT:\n${aiResponse.substring(0, 300)}${aiResponse.length > 300 ? '...\n' : '\n'}`;
        logEntry += `GENERATED CHOICES (${choices.length}):\n`;
        choices.forEach((c, i) => { logEntry += `  [${i+1}] ${c}\n`; });
        logEntry += `=================================\n`;
        settings.foreverLogText += logEntry;
        
        save();
    }

    function saveFailedParse(rawText) {
        const chatName = context.chatId || context.name2 || "Unknown_Chat";
        settings.failedParses.unshift({ timestamp: Date.now(), chatName, rawText });
        save();
    }

    function downloadForeverLog() {
        const logContent = settings.foreverLogText || "No forever logs recorded yet.";
        const blob = new Blob([logContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.download = `st_choice_stream_forever_log_${Date.now()}.txt`;
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

    // --- MODALS (Choice History & Failed Parses) ---

    function showHistoryModal(filterChat = "__ALL__", searchKeyword = "") {
        if (document.getElementById('cs_history_modal')) document.getElementById('cs_history_modal').remove();
        
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'cs_history_modal';
        modalOverlay.className = 'cs-modal-overlay';
        
        const currentChat = context.chatId || context.name2 || "Unknown_Chat";
        const history = settings.choiceHistory || {};
        const chatKeys = Object.keys(history);
        
        let allClusters = [];
        chatKeys.forEach(chat => {
            history[chat].forEach((cluster, idx) => {
                allClusters.push({ ...cluster, chatName: chat, originalIdx: idx });
            });
        });
        
        allClusters.sort((a,b) => b.timestamp - a.timestamp);

        let filtered = allClusters;
        if (filterChat !== "__ALL__") {
            filtered = filtered.filter(c => c.chatName === filterChat);
        }
        if (searchKeyword.trim() !== "") {
            const kw = searchKeyword.toLowerCase();
            filtered = filtered.filter(c => 
                c.chatName.toLowerCase().includes(kw) || 
                c.choices.some(choice => choice.toLowerCase().includes(kw)) ||
                (c.direction && c.direction.toLowerCase().includes(kw))
            );
        }

        let chatOptionsHtml = `<option value="__ALL__" ${filterChat === '__ALL__' ? 'selected' : ''}>All Chats (${allClusters.length} total saves)</option>`;
        chatKeys.sort((a,b) => a === currentChat ? -1 : (b === currentChat ? 1 : a.localeCompare(b))).forEach(chat => {
            const isCurr = chat === currentChat ? '★ [Current] ' : '';
            const count = history[chat].length;
            chatOptionsHtml += `<option value="${chat}" ${filterChat === chat ? 'selected' : ''}>${isCurr}${chat} (${count})</option>`;
        });

        let bodyHtml = "";
        if (filtered.length === 0) {
            bodyHtml = `<div style="text-align:center; padding: 40px 10px; color: rgba(255,255,255,0.4);">No saved choice history matches the criteria.</div>`;
        } else {
            filtered.forEach(cluster => {
                const dateStr = new Date(cluster.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + new Date(cluster.timestamp).toLocaleDateString();
                const totalWords = cluster.choices.reduce((acc, c) => acc + (c.trim() ? c.trim().split(/\s+/).length : 0), 0);
                const totalChars = cluster.choices.reduce((acc, c) => acc + c.length, 0);
                const estTokens = Math.round(totalWords * 1.3);

                bodyHtml += `
                    <div class="cs-history-cluster" data-chat="${cluster.chatName}" data-idx="${cluster.originalIdx}">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:6px;">
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <div style="font-weight:bold; font-size:0.95rem; color:#a78bfa;">
                                    ${cluster.chatName} 
                                    ${cluster.chatName === currentChat ? '<span style="color:#10b981; font-size:0.75rem; font-weight:normal;">(Active Chat)</span>' : ''}
                                </div>
                                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                    <span class="cs-stat-pill"><i class="fa-solid fa-clock"></i> ${dateStr}</span>
                                    <span class="cs-stat-pill" style="color:#38bdf8;"><i class="fa-solid fa-list-ol"></i> ${cluster.choices.length} options</span>
                                    <span class="cs-stat-pill"><i class="fa-solid fa-font"></i> ${totalWords}w / ${totalChars}c</span>
                                    <span class="cs-stat-pill" style="color:#fbbf24;"><i class="fa-solid fa-microchip"></i> ~${estTokens} tok</span>
                                </div>
                                ${cluster.direction ? `<div style="font-size:0.8rem; color:#f472b6;"><b>Prompt:</b> "${cluster.direction}"</div>` : ''}
                            </div>
                            <div style="display:flex; gap:8px;">
                                <button class="menu_button cs-touch-btn cs-load-cluster-btn margin0" style="padding:4px 8px; font-size:0.8rem; color:#10b981;" title="Load into choices UI"><i class="fa-solid fa-arrow-up-right-from-square"></i> Use</button>
                                <button class="menu_button cs-touch-btn cs-del-cluster-btn margin0" style="padding:4px 8px; font-size:0.8rem; color:#ef4444;" title="Delete this cluster"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>

                        <div class="cs-cluster-preview" style="font-size:0.88rem; opacity:0.85; cursor:pointer;">
                            ${cluster.choices.map((c, i) => `<div><span style="color:#8b5cf6;">[${i+1}]</span> ${c.substring(0, 110)}...</div>`).join('')}
                        </div>

                        <div class="cs-toggle-inspect" style="font-size:0.8rem; color:#8b5cf6; cursor:pointer; text-decoration:underline;">
                            <i class="fa-solid fa-chevron-down"></i> Inspect Full Options & AI Context
                        </div>

                        <div class="cs-cluster-details">
                            <div style="font-size:0.8rem; background:rgba(0,0,0,0.3); padding:8px; border-radius:4px; border-left:3px solid #8b5cf6;">
                                <b style="color:#a78bfa;">AI Context Snippet:</b>
                                <div style="margin-top:4px; max-height:80px; overflow-y:auto; opacity:0.85;">${cluster.aiResponse.replace(/</g, '&lt;')}</div>
                            </div>
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
                    <span style="font-size:1.1rem;"><i class="fa-solid fa-clock-rotate-left"></i> Choice History & Stats</span>
                    <div style="display:flex; gap:8px;">
                        <button id="cs_hist_download_btn" class="menu_button cs-touch-btn margin0" title="Export Long-term Log"><i class="fa-solid fa-download"></i> Log</button>
                        <button id="cs_hist_clearall_btn" class="menu_button cs-touch-btn margin0" style="color:#ef4444;"><i class="fa-solid fa-trash"></i> Clear All</button>
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
                    <div style="font-size:0.85rem; color:#94a3b8;">Showing <b>${filtered.length}</b> of <b>${allClusters.length}</b> records</div>
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
                    ? '<i class="fa-solid fa-chevron-down"></i> Inspect Full Options & AI Context'
                    : '<i class="fa-solid fa-chevron-up"></i> Hide Full Options';
            };
        });

        modalOverlay.querySelectorAll('.cs-load-cluster-btn').forEach(btn => {
            btn.onclick = () => {
                const parent = btn.closest('.cs-history-cluster');
                const chat = parent.getAttribute('data-chat');
                const idx = parent.getAttribute('data-idx');
                const cluster = settings.choiceHistory[chat][idx];
                renderChoices(cluster.choices);
                closeModal();
            };
        });

        modalOverlay.querySelectorAll('.cs-del-cluster-btn').forEach(btn => {
            btn.onclick = () => {
                const parent = btn.closest('.cs-history-cluster');
                const chat = parent.getAttribute('data-chat');
                const idx = parent.getAttribute('data-idx');
                settings.choiceHistory[chat].splice(idx, 1);
                if (settings.choiceHistory[chat].length === 0) delete settings.choiceHistory[chat];
                save();
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

        document.getElementById('cs_hist_download_btn').onclick = downloadForeverLog;
        document.getElementById('cs_hist_clearall_btn').onclick = () => {
            if (confirm("Delete ALL choice history across all chats? (Your text log file remains untouched)")) {
                settings.choiceHistory = {};
                save();
                showHistoryModal();
            }
        };
    }

    function showFailedModal() {
        if (document.getElementById('cs_failed_modal')) document.getElementById('cs_failed_modal').remove();
        
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'cs_failed_modal';
        modalOverlay.className = 'cs-modal-overlay';
        
        const fails = settings.failedParses || [];
        let bodyHtml = "";
        
        if (fails.length === 0) {
            bodyHtml = `<div style="text-align:center; padding: 40px 10px; color: rgba(255,255,255,0.4);">No unparsed LLM responses recorded. Everything is parsing smoothly!</div>`;
        } else {
            fails.forEach((fail, idx) => {
                const dateStr = new Date(fail.timestamp).toLocaleString();
                const wordCount = fail.rawText.trim().split(/\s+/).length;
                bodyHtml += `
                    <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.07); border-radius:6px; padding:10px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
                            <div>
                                <b style="color:#ef4444;">${fail.chatName}</b>
                                <div style="display:flex; gap:6px; margin-top:3px;">
                                    <span class="cs-stat-pill">${dateStr}</span>
                                    <span class="cs-stat-pill">${wordCount} words / ${fail.rawText.length} chars</span>
                                </div>
                            </div>
                            <div style="display:flex; gap:8px;">
                                <button class="menu_button cs-touch-btn cs-fail-copy-btn margin0" data-idx="${idx}"><i class="fa-solid fa-copy"></i> Copy</button>
                                <button class="menu_button cs-touch-btn cs-fail-del-btn margin0" data-idx="${idx}" style="color:#ef4444;"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>
                        <div class="cs-failed-item">${fail.rawText.replace(/</g, '&lt;')}</div>
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
                const idx = btn.getAttribute('data-idx');
                navigator.clipboard.writeText(settings.failedParses[idx].rawText).then(() => {
                    const oldHtml = btn.innerHTML;
                    btn.innerHTML = `<i class="fa-solid fa-check"></i> Copied!`;
                    btn.style.color = '#10b981';
                    setTimeout(() => { btn.innerHTML = oldHtml; btn.style.color = ''; }, 1500);
                });
            };
        });

        modalOverlay.querySelectorAll('.cs-fail-del-btn').forEach(btn => {
            btn.onclick = () => {
                const idx = btn.getAttribute('data-idx');
                settings.failedParses.splice(idx, 1);
                save();
                showFailedModal();
            };
        });

        document.getElementById('cs_fail_clearall_btn').onclick = () => {
            if (confirm("Delete all failed parse records?")) {
                settings.failedParses = [];
                save();
                showFailedModal();
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
        document.getElementById('cs_widget_fails').onclick = showFailedModal;
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
            if (goBtnIcon) goBtnIcon.className = "fa-solid fa-play";
            return;
        }

        isGenerating = true;
        const storySummary = extractStorySummary();
        const userStyle = buildUserStyleProfile();
        const dynamicMatrix = buildMatrixPrompt(false);
        
        try {
            log(`Fetching ${settings.numOptions} choices from Native backend...`, 1);
            const choices = await executeWithRetry(() => fetchChoices(storySummary, userStyle, dynamicMatrix, customDirection), 1, 3000);
            
            if (choices && choices.length > 0) {
                // FIXED: We render the choices visually FIRST before attempting to save to logs.
                // This prevents silent storage/memory limits from aborting the script before the popup appears.
                renderChoices(choices);
                
                try {
                    saveToHistory(choices, customDirection);
                } catch (historyErr) {
                    log("Warning: Failed to save to history: " + historyErr.message, 1);
                }
            }
        } catch (e) { 
            log("Fetch failed completely: " + e.message, 1); 
        } finally {
            isGenerating = false;
            if (goBtnIcon) goBtnIcon.className = "fa-solid fa-play";
        }
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

        try {
            let jsonStr = cleanText.replace(/```(?:json)?|```/gi, '').trim();
            
            if (!jsonStr.startsWith('[')) {
                const firstBrace = jsonStr.indexOf('{');
                if (firstBrace !== -1) jsonStr = '[' + jsonStr.substring(firstBrace);
            }
            if (!jsonStr.endsWith(']')) {
                const lastBrace = jsonStr.lastIndexOf('}');
                if (lastBrace !== -1) jsonStr = jsonStr.substring(0, lastBrace + 1) + ']';
            }

            const startIdx = jsonStr.indexOf('[');
            const endIdx = jsonStr.lastIndexOf(']');
            
            if (startIdx !== -1 && endIdx !== -1) {
                let parseableStr = jsonStr.substring(startIdx, endIdx + 1);
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
            }
        } catch (e) {
            log("Native JSON.parse failed (" + e.message + "), falling back to Regex extraction...", 2);
        }

        const choiceRegex = /"choice"\s*:\s*"([\s\S]*?)"(?=\s*(?:,|$}|\n))/gi;
        let match;
        while ((match = choiceRegex.exec(cleanText)) !== null) {
            let text = sanitizeOption(match[1]);
            if (text.length > 0) choices.push(text);
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

    async function fetchChoices(storySummary, userStyleText, dynamicMatrix, customDirection) {
        let safeUserName = context.name2 || "The Player";
        if (safeUserName === "SillyTavern System" || safeUserName === "System") safeUserName = "The Player";

        let stInstruction = settings.instructionPrompt
            .replaceAll("{{numOptions}}", settings.numOptions)
            .replaceAll("{{style_block}}", userStyleText)
            .replaceAll("{{matrix_block}}", dynamicMatrix)
            .replaceAll("{{user}}", safeUserName);

        if (customDirection && customDirection.trim() !== "") {
            const dirPrompt = `\n=====\nTARGET NARRATIVE DIRECTION\nALL choices MUST strictly execute or revolve around this specific intent: "${customDirection.trim()}"\nDO NOT deviate from this core premise!\n=====\n`;
    
            if (stInstruction.includes("CRITICAL RULES")) {
                stInstruction = stInstruction.replace("CRITICAL RULES", `${dirPrompt}\nCRITICAL RULES`);
            } else {
                if (stInstruction.endsWith("]")) {
                    stInstruction = stInstruction.slice(0, -1) + `\n${dirPrompt}]`;
                } else {
                    stInstruction += `\n${dirPrompt}`;
                }
            }
        }

        const compiledPrompt = storySummary ? `${storySummary}\n\n${stInstruction}` : stInstruction;
        log(`SENDING QUIET PROMPT:\n${compiledPrompt}`, 2);
        
        let rawResponse = await generateQuietPrompt({ quietPrompt: compiledPrompt, skipWIAN: false, removeReasoning: true });
        
        if (!rawResponse || rawResponse.trim() === "") {
            saveFailedParse("Empty API Response");
            throw new Error("Empty response from ST Proxy");
        }
        
        log(`RAW LLM RESPONSE:\n${rawResponse}`, 2);
        const choices = parseLLMArray(rawResponse);
        
        if (!choices || choices.length === 0) {
            saveFailedParse(rawResponse);
            throw new Error("Failed to parse choices from response");
        }
        
        return choices;
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
                        <label class="checkbox_label flex-container marginBot5">
                            <input type="checkbox" id="cs_active" ${settings.enabled ? "checked" : ""}>
                            <span>Auto-generate Choices</span>
                        </label>
                        <label class="checkbox_label flex-container marginBot5">
                            <input type="checkbox" id="cs_skip_interrupt" ${settings.skipInterrupted ? "checked" : ""}>
                            <span>Skip on Interrupted Generation</span>
                        </label>
                        
                        <hr>
                        <h4>Context Integration</h4>
                        <label class="checkbox_label flex-container marginBot5" title="Inject ST's running summary into the choice generator.">
                            <input type="checkbox" id="cs_include_summary" ${settings.includeSummary ? "checked" : ""}>
                            <span>Include Lore Summaries</span>
                        </label>
                        <label class="checkbox_label flex-container marginBot5" title="Extract past messages to teach the LLM your writing style.">
                            <input type="checkbox" id="cs_use_user_style" ${settings.useUserStyle ? "checked" : ""}>
                            <span>Enable User Style Profiler</span>
                        </label>
                        <label class="checkbox_label flex-container marginBot5" title="Automatically structure options using the matrix below.">
                            <input type="checkbox" id="cs_dynamic_matrix" ${settings.dynamicMatrix ? "checked" : ""}>
                            <span>Use Dynamic Tone Matrix</span>
                        </label>

                        <div class="flex-container alignitemscenter marginBot5 justifySpaceBetween marginTop5" style="border-bottom: 1px solid var(--SmartThemeBorderColor); padding-bottom: 5px;">
                            <h4 class="margin0">Prompts & Matrix</h4>
                            <div id="cs_reset_prompts" class="menu_button interactable cs-touch-btn margin0" tabindex="0" role="button" title="Restore Default Prompts">
                                <i class="fa-solid fa-rotate-left"></i> Restore Default Prompts
                            </div>
                        </div>
                        
                        <div class="flex-container alignitemscenter marginBot5" title="Delay API calls by X seconds to prevent crashes.">
                            <label style="flex:1;">API Delay: <span id="cs_delay_val">${settings.generationDelay}</span>s</label>
                            <input type="range" id="cs_delay" style="flex:1;" value="${settings.generationDelay}" min="0" max="15" step="1">
                        </div>
                        
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;"><strong>Number of Options:</strong> <span id="cs_num_val">${settings.numOptions}</span></label>
                            <input type="range" id="cs_num" style="flex:1;" value="${settings.numOptions}" min="1" max="10">
                        </div>
                        
                        <div class="flex-container flexFlowColumn marginBot5" style="border-left: 2px solid var(--SmartThemeBorderColor); padding-left: 10px;">
                            <div class="flex-container alignitemscenter justifySpaceBetween">
                                <label><strong>Option Tone Matrix</strong> <small>(Applied to {{matrix_block}})</small></label>
                                <div id="cs_add_matrix" class="menu_button interactable cs-touch-btn margin0" tabindex="0" role="button" style="padding: 2px 8px; font-size: 0.85rem;">
                                    <i class="fa-solid fa-plus"></i> Add Rule
                                </div>
                            </div>
                            <div id="cs_matrix_warning" style="color: #ef4444; font-size: 0.85rem; margin-top: 4px; display: none;"><i class="fa-solid fa-triangle-exclamation"></i> Warning: Some matrix targets exceed the Number of Options.</div>
                            <div id="cs_matrix_list" class="flex-container flexFlowColumn marginTop5"></div>
                        </div>

                        <div class="flex-container flexFlowColumn marginBot5">
                            <label for="cs_user_style_template"><strong>User Style Block Template</strong></label>
                            <textarea id="cs_user_style_template" class="text_pole textarea_compact autoSetHeight" rows="3">${settings.userStyleTemplate}</textarea>
                        </div>
                        
                        <div class="flex-container flexFlowColumn marginBot5">
                            <label for="cs_instruction_prompt"><strong>Master Instruction Prompt</strong> <small>(Supports {{style_block}} and {{matrix_block}})</small></label>
                            <textarea id="cs_instruction_prompt" class="text_pole textarea_compact autoSetHeight" rows="8">${settings.instructionPrompt}</textarea>
                        </div>
                        
                        <hr>
                        <h4>UI Configuration</h4>
                        
                        <div class="flex-container alignitemscenter marginBot5">
                            <label style="flex:1;">Widget Panel Width: <span id="cs_width_val">${settings.widget_width}</span>vw</label>
                            <input type="range" id="cs_width" style="flex:1;" value="${settings.widget_width}" min="30" max="100">
                        </div>

                        <div class="flex-container flexFlowColumn marginBot5">
                            <label for="cs_dbg">Debug Level (F12 Console)</label>
                            <select id="cs_dbg" class="text_pole">
                                <option value="0" ${settings.debugMode==0?'selected':''}>0 - Off</option>
                                <option value="1" ${settings.debugMode==1?'selected':''}>1 - Normal</option>
                                <option value="2" ${settings.debugMode==2?'selected':''}>2 - Verbose (Show Prompts)</option>
                            </select>
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

        $("#cs_active").on("change", function() { settings.enabled = this.checked; save(); });
        $("#cs_skip_interrupt").on("change", function() { settings.skipInterrupted = this.checked; save(); });
        $("#cs_include_summary").on("change", function() { settings.includeSummary = this.checked; save(); });
        $("#cs_use_user_style").on("change", function() { settings.useUserStyle = this.checked; updateMatrixUI(); save(); });
        $("#cs_dynamic_matrix").on("change", function() { settings.dynamicMatrix = this.checked; updateMatrixUI(); save(); });
        
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
        
        $("#cs_width").on("input", function() { 
            settings.widget_width = this.value; 
            $("#cs_width_val").text(this.value); 
            document.documentElement.style.setProperty('--cs-panel-width', this.value + 'vw');
            save(); 
        });

        $("#cs_y_top").on("input", function() { settings.offset_top = this.value; $("#cs_y_top_val").text(this.value); updateContainerPosition(); save(); });
        $("#cs_y_bot").on("input", function() { settings.offset_bottom = this.value; $("#cs_y_bot_val").text(this.value); updateContainerPosition(); save(); });

        $("#cs_dbg").on("change", function() { settings.debugMode = parseInt(this.value); EXT_LOG_LEVEL = settings.debugMode; save(); });
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