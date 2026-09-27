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
            if (!settings.choiceHistory) settings.choiceHistory = {};
            if (!settings.failedParses) settings.failedParses = [];
            if (!settings.foreverLogText) settings.foreverLogText = "";
        }
    }

    function injectCSS() {
        if (document.getElementById('cs_custom_css')) return;
        const style = document.createElement('style');
        style.id = 'cs_custom_css';
        style.innerHTML = `
            .cs-modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 99999; display: flex; justify-content: center; align-items: center; backdrop-filter: blur(3px); }
            .cs-modal { background: var(--SmartThemeBlurTintColor, #1e1e2e); border: 1px solid var(--SmartThemeBorderColor, #444); padding: 15px; border-radius: 8px; width: 95vw; max-width: 650px; max-height: 85vh; overflow-y: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.8); display: flex; flex-direction: column; gap: 10px; color: var(--SmartThemeBodyColor, #fff); }
            .cs-modal-header { display: flex; justify-content: space-between; align-items: center; font-weight: bold; font-size: 1.2em; border-bottom: 1px solid var(--SmartThemeBorderColor, #555); padding-bottom: 10px; margin-bottom: 10px; flex-wrap: wrap; gap: 5px; }
            .cs-history-chat { margin-bottom: 10px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; overflow: hidden; }
            .cs-history-chat-title { background: rgba(0,0,0,0.2); padding: 10px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 5px;}
            .cs-history-chat-title:hover { background: rgba(0,0,0,0.4); }
            .cs-history-cluster { padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; display: flex; flex-direction: column; gap: 8px; transition: background 0.2s; }
            .cs-history-cluster:hover { background: rgba(255,255,255,0.05); }
            .cs-failed-item { background: rgba(239, 68, 68, 0.05); border-left: 4px solid #ef4444; padding: 12px; margin-bottom: 12px; border-radius: 0 4px 4px 0; font-family: monospace; white-space: pre-wrap; word-break: break-word; font-size: 0.9em; max-height: 300px; overflow-y: auto;}
            .cs-widget-extra-btn { flex: none !important; width: 35px !important; }
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

    function saveToHistory(choices) {
        const chatName = context.chatId || context.name2 || "Unknown_Chat";
        const aiResponse = extractAIResponseContext();
        const timestamp = Date.now();
        
        if (!settings.choiceHistory[chatName]) settings.choiceHistory[chatName] = [];
        
        settings.choiceHistory[chatName].unshift({ timestamp, aiResponse, choices });
        
        // Append to Forever Log securely (avoiding .\ root pollution)
        if (!settings.foreverLogText) settings.foreverLogText = "";
        let logEntry = `\n=================================\n`;
        logEntry += `DATE: ${new Date(timestamp).toLocaleString()}\n`;
        logEntry += `CHAT: ${chatName}\n`;
        logEntry += `AI CONTEXT:\n${aiResponse.substring(0, 300)}${aiResponse.length > 300 ? '...\n' : '\n'}`;
        logEntry += `GENERATED CHOICES:\n`;
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

    // --- MODALS (History & Failed) ---

    function showHistoryModal() {
        if (document.getElementById('cs_history_modal')) document.getElementById('cs_history_modal').remove();
        
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'cs_history_modal';
        modalOverlay.className = 'cs-modal-overlay';
        
        let html = `
            <div class="cs-modal">
                <div class="cs-modal-header">
                    <span><i class="fa-solid fa-clock-rotate-left"></i> Choice History</span>
                    <div style="display:flex; gap: 8px; flex-wrap: wrap;">
                        <button id="cs_hist_download" class="menu_button interactable margin0" title="Export Log to Downloads Folder"><i class="fa-solid fa-download"></i> Log</button>
                        <button id="cs_hist_clearall" class="menu_button interactable margin0" style="color: #ef4444;"><i class="fa-solid fa-trash"></i> All</button>
                        <button id="cs_hist_close" class="menu_button interactable margin0"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
                <div class="cs-modal-body" style="display:flex; flex-direction:column; gap: 10px;">
        `;
        
        const currentChat = context.chatId || context.name2 || "Unknown_Chat";
        const history = settings.choiceHistory || {};
        const chatNames = Object.keys(history).sort((a,b) => a === currentChat ? -1 : (b === currentChat ? 1 : 0));
        
        if (chatNames.length === 0) {
            html += `<div style="text-align:center; padding: 20px; color: rgba(255,255,255,0.5);">No choice history saved yet.</div>`;
        } else {
            chatNames.forEach(chat => {
                const clusters = history[chat];
                if (!clusters || clusters.length === 0) return;
                
                html += `
                    <div class="cs-history-chat">
                        <div class="cs-history-chat-title" data-chat="${chat}">
                            <span><b>${chat}</b> <small>(${clusters.length} generations)</small> ${chat === currentChat ? '<span style="color:#10b981; font-size:0.8em; margin-left:5px;">[Current Chat]</span>' : ''}</span>
                            <div style="display:flex; gap:15px; align-items:center;">
                                <i class="fa-solid fa-trash chat-delete-icon" data-chat="${chat}" style="color: #ef4444; font-size: 1.1em;" title="Clear this chat's history"></i>
                                <i class="fa-solid fa-chevron-down chat-toggle-icon"></i>
                            </div>
                        </div>
                        <div class="cs-history-chat-content" id="cs_hist_content_${chat}" style="${chat === currentChat ? 'display:block;' : 'display:none;'}">
                `;
                
                clusters.forEach((cluster, idx) => {
                    const dateStr = new Date(cluster.timestamp).toLocaleString();
                    const firstLines = cluster.choices.map(c => c.split('.')[0] + '...').join('<br><span style="color:rgba(255,255,255,0.3);">-</span> ');
                    
                    html += `
                            <div class="cs-history-cluster" data-chat="${chat}" data-idx="${idx}">
                                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px dashed rgba(255,255,255,0.2); padding-bottom:3px; margin-bottom:3px;">
                                    <small style="color:#8b5cf6;"><i class="fa-solid fa-bolt"></i> ${dateStr} | ${cluster.choices.length} options</small>
                                    <i class="fa-solid fa-trash cluster-delete-icon" data-chat="${chat}" data-idx="${idx}" style="color: #ef4444; padding:5px;" title="Delete cluster"></i>
                                </div>
                                <div style="font-size:0.9em; max-height: 70px; overflow:hidden; text-overflow:ellipsis;">
                                    <span style="color:rgba(255,255,255,0.3);">-</span> ${firstLines}
                                </div>
                            </div>
                    `;
                });
                
                html += `</div></div>`;
            });
        }
        
        html += `</div></div>`;
        modalOverlay.innerHTML = html;
        document.body.appendChild(modalOverlay);
        
        document.getElementById('cs_hist_close').onclick = () => modalOverlay.remove();
        
        modalOverlay.querySelectorAll('.cs-history-chat-title').forEach(el => {
            el.onclick = (e) => {
                if (e.target.classList.contains('chat-delete-icon')) return; 
                const chat = el.getAttribute('data-chat');
                const content = document.getElementById(`cs_hist_content_${chat}`);
                const icon = el.querySelector('.chat-toggle-icon');
                if (content.style.display === 'none') {
                    content.style.display = 'block';
                    icon.classList.replace('fa-chevron-down', 'fa-chevron-up');
                } else {
                    content.style.display = 'none';
                    icon.classList.replace('fa-chevron-up', 'fa-chevron-down');
                }
            };
        });
        
        modalOverlay.querySelectorAll('.cs-history-cluster').forEach(el => {
            el.onclick = (e) => {
                if (e.target.classList.contains('cluster-delete-icon')) return;
                const chat = el.getAttribute('data-chat');
                const idx = el.getAttribute('data-idx');
                const cluster = settings.choiceHistory[chat][idx];
                renderChoices(cluster.choices);
                modalOverlay.remove();
            };
        });
        
        modalOverlay.querySelectorAll('.chat-delete-icon').forEach(el => {
            el.onclick = (e) => {
                const chat = el.getAttribute('data-chat');
                if (confirm(`Delete ALL choice history for chat: ${chat}?`)) {
                    delete settings.choiceHistory[chat];
                    save();
                    showHistoryModal(); 
                }
            };
        });
        
        modalOverlay.querySelectorAll('.cluster-delete-icon').forEach(el => {
            el.onclick = (e) => {
                const chat = el.getAttribute('data-chat');
                const idx = el.getAttribute('data-idx');
                settings.choiceHistory[chat].splice(idx, 1);
                if (settings.choiceHistory[chat].length === 0) delete settings.choiceHistory[chat];
                save();
                showHistoryModal(); 
            };
        });
        
        document.getElementById('cs_hist_clearall').onclick = () => {
            if (confirm("Delete ALL choice history across ALL chats? (Your Forever Log text file will remain intact)")) {
                settings.choiceHistory = {};
                save();
                showHistoryModal();
            }
        };
        
        document.getElementById('cs_hist_download').onclick = downloadForeverLog;
    }

    function showFailedModal() {
        if (document.getElementById('cs_failed_modal')) document.getElementById('cs_failed_modal').remove();
        
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'cs_failed_modal';
        modalOverlay.className = 'cs-modal-overlay';
        
        let html = `
            <div class="cs-modal">
                <div class="cs-modal-header">
                    <span><i class="fa-solid fa-triangle-exclamation"></i> Failed Parses</span>
                    <div style="display:flex; gap: 8px;">
                        <button id="cs_fail_clearall" class="menu_button interactable margin0" style="color: #ef4444;"><i class="fa-solid fa-trash"></i> All</button>
                        <button id="cs_fail_close" class="menu_button interactable margin0"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
                <div class="cs-modal-body" style="display:flex; flex-direction:column; gap: 10px;">
        `;
        
        const fails = settings.failedParses || [];
        if (fails.length === 0) {
            html += `<div style="text-align:center; padding: 20px; color: rgba(255,255,255,0.5);">No failed parses found!</div>`;
        } else {
            fails.forEach((fail, idx) => {
                const dateStr = new Date(fail.timestamp).toLocaleString();
                html += `
                    <div class="cs-failed-item">
                        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px dashed rgba(239, 68, 68, 0.4); padding-bottom:5px; margin-bottom:8px;">
                            <div><small style="color:#ef4444;">${dateStr} | Chat: ${fail.chatName}</small></div>
                            <div style="display:flex; gap:15px;">
                                <i class="fa-solid fa-copy copy-fail-icon" data-idx="${idx}" style="cursor:pointer; font-size:1.1em;" title="Copy"></i>
                                <i class="fa-solid fa-trash del-fail-icon" data-idx="${idx}" style="cursor:pointer; font-size:1.1em;" title="Delete"></i>
                            </div>
                        </div>
                        <div>${fail.rawText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                    </div>
                `;
            });
        }
        
        html += `</div></div>`;
        modalOverlay.innerHTML = html;
        document.body.appendChild(modalOverlay);
        
        document.getElementById('cs_fail_close').onclick = () => modalOverlay.remove();
        document.getElementById('cs_fail_clearall').onclick = () => {
            if (confirm("Delete ALL failed parses?")) {
                settings.failedParses = [];
                save();
                showFailedModal();
            }
        };
        
        modalOverlay.querySelectorAll('.copy-fail-icon').forEach(el => {
            el.onclick = () => {
                const idx = el.getAttribute('data-idx');
                navigator.clipboard.writeText(settings.failedParses[idx].rawText).then(() => {
                    el.classList.replace('fa-copy', 'fa-check');
                    el.style.color = '#10b981';
                    setTimeout(() => {
                        el.classList.replace('fa-check', 'fa-copy');
                        el.style.color = '';
                    }, 2000);
                });
            };
        });
        
        modalOverlay.querySelectorAll('.del-fail-icon').forEach(el => {
            el.onclick = () => {
                settings.failedParses.splice(el.getAttribute('data-idx'), 1);
                save();
                showFailedModal();
            };
        });
    }

    function buildFloatingWidget() {
        if (document.getElementById('cs_floating_widget')) return;

        const widget = document.createElement('div');
        widget.id = 'cs_floating_widget';
        widget.style.left = settings.widget_left;
        if (settings.widget_top) widget.style.top = settings.widget_top;
        if (settings.widget_bottom) widget.style.bottom = settings.widget_bottom;

        widget.innerHTML = `
            <div id="cs_widget_btn" title="Drag to move. Click to generate.">
                <i class="fa-solid fa-code-branch"></i>
            </div>
            <div id="cs_widget_panel" style="display:flex; flex-wrap:nowrap; gap:4px; max-width: 90vw;">
                <input type="text" id="cs_widget_input" placeholder="Custom direction..." autocomplete="off">
                <button class="cs_widget_action cs-widget-extra-btn" id="cs_widget_history" title="Choice History"><i class="fa-solid fa-clock-rotate-left"></i></button>
                <button class="cs_widget_action cs-widget-extra-btn" id="cs_widget_fails" title="Failed Parses"><i class="fa-solid fa-triangle-exclamation"></i></button>
                <button class="cs_widget_action" id="cs_widget_go" title="Generate Choices"><i class="fa-solid fa-play"></i></button>
                <button class="cs_widget_action" id="cs_widget_close" title="Close Panel"><i class="fa-solid fa-xmark"></i></button>
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
            document.addEventListener('touchend', onDragEnd);
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

        function onDragEnd() {
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('touchmove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);
            document.removeEventListener('touchend', onDragEnd);
            
            if (!isDragging) {
                if (panel.classList.contains('is-open')) {
                    panel.classList.remove('is-open');
                } else {
                    panel.classList.add('is-open');
                    input.focus(); 
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
        
        document.getElementById('cs_widget_history').onclick = showHistoryModal;
        document.getElementById('cs_widget_fails').onclick = showFailedModal;
    }

    function addMagicWandButton() {
        const wandMenu = document.getElementById("extensionsMenu");
        if (!wandMenu || document.getElementById("cs_wand_btn")) return !!document.getElementById("cs_wand_btn"); 

        const btn = document.createElement("div");
        btn.id = "cs_wand_btn";
        btn.className = "list-group-item flex-container flexGap5 interactable";
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
                saveToHistory(choices);
                renderChoices(choices);
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
            minBtn.className = "choice-stream-util-btn interactable";
            minBtn.innerHTML = "<i class='fa-solid fa-minus'></i>";
            
            const closeBtn = document.createElement("button");
            closeBtn.className = "choice-stream-util-btn interactable";
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
                toggleBtn.className = "choice-card-toggle interactable";
                toggleBtn.innerHTML = "<i class='fa-solid fa-chevron-right choice-card-toggle-icon'></i>";
                
                toggleBtn.onclick = (e) => {
                    e.stopPropagation();
                    card.classList.toggle("is-collapsed");
                };

                const btn = document.createElement("button");
                btn.className = "choice-stream-btn interactable";
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
                cardCloseBtn.className = "choice-card-close interactable";
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
                <div class="menu_button interactable matrix-del margin0" style="padding:4px 8px;" data-idx="${index}"><i class="fa-solid fa-trash"></i></div>
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
                            <div id="cs_reset_prompts" class="menu_button interactable margin0" tabindex="0" role="button" title="Restore Default Prompts">
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
                                <div id="cs_add_matrix" class="menu_button interactable margin0" tabindex="0" role="button" style="padding: 2px 8px; font-size: 0.85rem;">
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
                            <div id="cs_test" class="menu_button interactable flex1 margin0" tabindex="0" role="button">
                                <i class="fa-solid fa-eye"></i> Test UI
                            </div>
                            <div id="cs_manual" class="menu_button interactable flex1 margin0" tabindex="0" role="button">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> Force Gen
                            </div>
                            <div id="cs_reset_widget" class="menu_button interactable flex1 margin0" tabindex="0" role="button" title="Snap Floating Widget back to Default">
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