(function () {
    const MODULE_NAME = "st_choice_stream";
    
    // Safely fetch ST context
    const context = window.SillyTavern?.getContext?.();
    if (!context) {
        console.error("[Choices Ext ERROR] Failed to fetch SillyTavern Context. Extension aborted.");
        return;
    }
    const { eventSource, event_types } = context;

    let settings = {
        enabled: true,
        debugMode: 1, // 0 = off, 1 = normal, 2 = verbose
        numOptions: 4,
        layout: "column",
        position: "bottom",
        offset_top: 0,
        offset_bottom: 50,
        offset_left: 10,
        offset_right: 10,
        systemPrompt: "Generate a JSON array of {{numOptions}} short action choices based on the narrative. Output ONLY raw JSON: [\"Choice 1\", \"Choice 2\"]"
    };

    let choiceContainer = null;
    let isInputManuallyEdited = false;
    let lastInsertedText = "";

    // --- Custom Logger ---
    function log(text, level = 1) {
        if (settings.debugMode >= level) {
            const prefix = `[ST-Choices]:`;
            if (level === 1) console.log(`%c${prefix} %c${text}`, 'color: #10b981; font-weight: bold;', 'color: inherit;');
            if (level === 2) console.log(`%c${prefix} [VERBOSE] %c${text}`, 'color: #8b5cf6;', 'color: gray;');
        }
    }

    function logError(text, err) {
        if (settings.debugMode > 0) {
            console.error(`[ST-Choices ERROR]: ${text}`, err);
        }
    }

    function loadSettings() {
        if (context.extensionSettings[MODULE_NAME]) {
            settings = Object.assign(settings, context.extensionSettings[MODULE_NAME]);
        }
        log("Settings loaded.", 2);
    }

    async function init() {
        log("Initializing extension...", 1);
        loadSettings();
        setupInputTracker();
        renderSettingsMenu();
        registerSlashCommand();

        // Core Event Hooks (The part that was broken)
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            log("Character message rendered. Checking if generation is enabled...", 2);
            if (settings.enabled) triggerGeneration();
        });
        
        eventSource.on(event_types.MESSAGE_SENT, () => {
            log("User sent a message. Wiping UI.", 2);
            clearUI();
        });
        
        eventSource.on(event_types.GENERATION_STARTED, () => {
            log("New text generation started. Wiping UI to prevent overlap.", 2);
            clearUI();
        });

        log("Initialization complete. Hooks attached.", 1);
    }

    function setupInputTracker() {
        const textarea = document.getElementById("send_textarea");
        if (!textarea) return;
        textarea.addEventListener("input", () => {
            if (textarea.value.trim() === "" || textarea.value === lastInsertedText) {
                isInputManuallyEdited = false;
            } else {
                isInputManuallyEdited = true;
            }
        });
    }

    // Register a native ST Slash Command to force generation manually
    function registerSlashCommand() {
        if (!context.slashCommandParser) return;
        context.slashCommandParser.addCommandObject({
            command: "genchoices",
            aliases: ["choices"],
            description: "Force generate narrative choices based on the last message.",
            callback: () => {
                log("Manual generation triggered via slash command.", 1);
                clearUI();
                triggerGeneration();
            }
        });
        log("Slash command /choices registered.", 2);
    }

    async function triggerGeneration() {
        const chat = context.chat;
        if (!chat || !chat.length || chat[chat.length - 1].is_user) {
            log("Aborted generation: Chat is empty or last message was from the user.", 2);
            return;
        }

        try {
            const lastText = chat[chat.length - 1].mes;
            log(`Fetching ${settings.numOptions} choices from backend...`, 1);
            const choices = await fetchChoices(lastText);
            
            if (choices && choices.length > 0) {
                log(`Successfully parsed ${choices.length} choices. Rendering UI.`, 1);
                renderChoices(choices);
            } else {
                logError("Backend returned an empty or invalid choice array.", null);
            }
        } catch (e) { 
            logError("Generation Network/Parsing Failed.", e); 
        }
    }

    async function fetchChoices(storyText) {
        const prompt = settings.systemPrompt.replace("{{numOptions}}", settings.numOptions);
        const requestBody = {
            messages: [
                { role: "system", content: prompt }, 
                { role: "user", content: storyText }
            ],
            temperature: 0.7,
            max_tokens: 200
        };

        const response = await fetch("/api/chat/completions", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                ...(context.getNetworkHeaders ? context.getNetworkHeaders() : {})
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) throw new Error(`HTTP Status ${response.status}`);
        
        const data = await response.json();
        const content = data.choices[0].message.content;
        log(`Raw LLM Response: ${content}`, 2);
        
        // Regex to yank JSON array even if wrapped in markdown code blocks
        const match = content.match(/\[[\s\S]*\]/);
        return match ? JSON.parse(match[0]) : null;
    }

    function renderChoices(choices) {
        clearUI();
        const parent = document.getElementById("form_main") || document.body;
        
        choiceContainer = document.createElement("div");
        choiceContainer.className = "choice-stream-container";
        updatePosition();

        const controls = document.createElement("div");
        controls.className = "choice-stream-controls";

        const minBtn = document.createElement("button");
        minBtn.className = "choice-stream-util-btn";
        minBtn.innerText = "—";
        minBtn.onclick = (e) => {
            e.stopPropagation();
            choiceContainer.classList.toggle("choice-stream-minimized");
        };

        const closeBtn = document.createElement("button");
        closeBtn.className = "choice-stream-util-btn";
        closeBtn.innerText = "✕";
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            clearUI();
        };

        controls.append(minBtn, closeBtn);
        choiceContainer.append(controls);

        const box = document.createElement("div");
        box.className = `choice-stream-box choice-stream-layout-${settings.layout}`;

        choices.forEach(text => {
            const btn = document.createElement("button");
            btn.className = "choice-stream-btn";
            btn.innerText = text;
            btn.onclick = () => {
                log(`User clicked choice: "${text}"`, 2);
                const textarea = document.getElementById("send_textarea");
                if (isInputManuallyEdited) {
                    const start = textarea.selectionStart;
                    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(textarea.selectionEnd);
                } else {
                    textarea.value = text;
                }
                lastInsertedText = textarea.value;
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
                textarea.focus();
            };
            box.append(btn);
        });

        choiceContainer.append(box);
        parent.append(choiceContainer);
    }

    function updatePosition() {
        if (!choiceContainer) return;
        choiceContainer.style.left = `${settings.offset_left}px`;
        choiceContainer.style.right = `${settings.offset_right}px`;
        if (settings.position === "bottom") {
            choiceContainer.style.bottom = `${settings.offset_bottom}px`;
            choiceContainer.style.top = "auto";
        } else {
            choiceContainer.style.top = `${settings.offset_top}px`;
            choiceContainer.style.bottom = "auto";
        }
    }

    function clearUI() {
        if (choiceContainer) {
            choiceContainer.remove();
            choiceContainer = null;
            log("Cleared Choice UI from screen.", 2);
        }
    }

    function renderSettingsMenu() {
        const html = `
            <div class="inline-drawer"><div class="inline-drawer-header"><b>Narrative Choice Stream</b></div>
            <div class="inline-drawer-content">
                <label><input type="checkbox" id="cs_active" ${settings.enabled ? "checked" : ""}> Auto-generate Choices</label><br>
                <label>Options: <input type="number" id="cs_num" value="${settings.numOptions}" style="width:50px"></label><br>
                <label>Layout: <select id="cs_lay"><option value="row" ${settings.layout === 'row' ? 'selected' : ''}>Row</option><option value="column" ${settings.layout === 'column' ? 'selected' : ''}>Column</option></select></label><br>
                <label>Dock: <select id="cs_pos"><option value="top" ${settings.position === 'top' ? 'selected' : ''}>Top</option><option value="bottom" ${settings.position === 'bottom' ? 'selected' : ''}>Bottom</option></select></label><br>
                Offsets: L<input type="number" id="cs_l" value="${settings.offset_left}" style="width:40px"> R<input type="number" id="cs_r" value="${settings.offset_right}" style="width:40px"> 
                T<input type="number" id="cs_t" value="${settings.offset_top}" style="width:40px"> B<input type="number" id="cs_b" value="${settings.offset_bottom}" style="width:40px"><br><br>
                
                <b>Logging/Debug Level</b><br>
                <select id="cs_dbg">
                    <option value="0" ${settings.debugMode == 0 ? 'selected' : ''}>Off (Errors Only)</option>
                    <option value="1" ${settings.debugMode == 1 ? 'selected' : ''}>Normal (Info/Clicks)</option>
                    <option value="2" ${settings.debugMode == 2 ? 'selected' : ''}>Verbose (Raw Prompts/Backend)</option>
                </select><br><br>

                <button id="cs_manual" class="menu_button">Force Generate Now</button><br>
                <textarea id="cs_prompt" style="width:100%; height:60px; font-size:10px;">${settings.systemPrompt}</textarea>
            </div></div>`;
        
        // Ensure we hook into ST's correct extensions container
        const target = document.getElementById("extensions_settings") || document.getElementById("extensions_settings2");
        if (target) {
            target.insertAdjacentHTML('beforeend', html);
        } else {
            logError("Could not find the extensions_settings div to render the menu.", null);
        }

        document.getElementById("cs_active").addEventListener("change", (e) => { settings.enabled = e.target.checked; save(); });
        document.getElementById("cs_num").addEventListener("change", (e) => { settings.numOptions = e.target.value; save(); });
        document.getElementById("cs_lay").addEventListener("change", (e) => { settings.layout = e.target.value; save(); });
        document.getElementById("cs_pos").addEventListener("change", (e) => { settings.position = e.target.value; save(); });
        document.getElementById("cs_l").addEventListener("change", (e) => { settings.offset_left = e.target.value; save(); });
        document.getElementById("cs_r").addEventListener("change", (e) => { settings.offset_right = e.target.value; save(); });
        document.getElementById("cs_t").addEventListener("change", (e) => { settings.offset_top = e.target.value; save(); });
        document.getElementById("cs_b").addEventListener("change", (e) => { settings.offset_bottom = e.target.value; save(); });
        document.getElementById("cs_dbg").addEventListener("change", (e) => { settings.debugMode = parseInt(e.target.value); save(); log("Debug level changed.", 1); });
        document.getElementById("cs_prompt").addEventListener("input", (e) => { settings.systemPrompt = e.target.value; save(); });
        document.getElementById("cs_manual").addEventListener("click", () => { clearUI(); triggerGeneration(); });
    }

    function save() {
        context.extensionSettings[MODULE_NAME] = settings;
        if (context.saveSettingsDebounced) context.saveSettingsDebounced();
        if (choiceContainer) updatePosition();
    }

    // Safely boot the extension using jQuery document ready (ST standard)
    jQuery(async () => {
        try {
            await init();
        } catch (err) {
            logError("Failed during extension initialization.", err);
        }
    });
})();
