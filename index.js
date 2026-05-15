(function () {
    const MODULE_NAME = "st_choice_stream";
    
    // 1. Robust Context Fetching
    const context = window.SillyTavern?.getContext?.();
    if (!context) {
        console.error("[Choices Ext] SillyTavern context not found. Is the extension in the correct folder?");
        return;
    }
    const { eventSource, event_types } = context;

    let settings = {
        enabled: true,
        debugMode: 1,
        numOptions: 4,
        layout: "column",
        position: "bottom",
        offset_top: 0,
        offset_bottom: 60,
        offset_left: 10,
        offset_right: 10,
        systemPrompt: "Generate a JSON array of {{numOptions}} short action choices based on the narrative. Output ONLY raw JSON: [\"Choice 1\", \"Choice 2\"]"
    };

    let choiceContainer = null;
    let isInputManuallyEdited = false;
    let lastInsertedText = "";

    // --- Logger ---
    function log(text, level = 1) {
        if (settings.debugMode >= level) {
            console.log(`%c[ST-Choices] ${text}`, level === 2 ? 'color: #8b5cf6;' : 'color: #10b981; font-weight: bold;');
        }
    }

    function loadSettings() {
        if (context.extensionSettings[MODULE_NAME]) {
            settings = Object.assign(settings, context.extensionSettings[MODULE_NAME]);
        }
    }

    // --- Initialization ---
    async function init() {
        log("Booting Extension Engine...");
        loadSettings();
        setupInputTracker();
        registerSlashCommand();
        
        // Use a persistent interval to ensure the menu renders even if the DOM is slow
        const menuRetry = setInterval(() => {
            if (renderSettingsMenu()) {
                log("Settings Menu injected successfully.");
                clearInterval(menuRetry);
            }
        }, 1000);

        // Events
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            log("AI Message detected. Auto-generating...", 2);
            if (settings.enabled) triggerGeneration();
        });
        
        eventSource.on(event_types.MESSAGE_SENT, clearUI);
        eventSource.on(event_types.GENERATION_STARTED, clearUI);
        
        log("Hooks Attached. Ready for AI response or /choices command.");
    }

    function setupInputTracker() {
        const textarea = document.getElementById("send_textarea");
        if (!textarea) return;
        textarea.addEventListener("input", () => {
            isInputManuallyEdited = (textarea.value.trim() !== "" && textarea.value !== lastInsertedText);
        });
    }

    function registerSlashCommand() {
        if (context.slashCommandParser) {
            context.slashCommandParser.addCommandObject({
                command: "choices",
                callback: () => { log("Slash command triggered."); triggerGeneration(); },
                helpString: "Generates narrative choices."
            });
        }
    }

    // --- UI Logic ---
    async function triggerGeneration(isTest = false) {
        if (isTest) {
            log("Rendering Test UI...");
            renderChoices(["Test Option 1", "Test Option 2", "Test Option 3"]);
            return;
        }

        const chat = context.chat;
        if (!chat?.length || chat[chat.length - 1].is_user) {
            log("No AI message to base choices on.");
            return;
        }

        try {
            const lastText = chat[chat.length - 1].mes;
            log("Calling AI for choices...");
            const choices = await fetchChoices(lastText);
            if (choices) renderChoices(choices);
        } catch (e) { log("Fetch failed: " + e.message); }
    }

    async function fetchChoices(storyText) {
        const prompt = settings.systemPrompt.replace("{{numOptions}}", settings.numOptions);
        const response = await fetch("/api/chat/completions", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                ...(context.getNetworkHeaders ? context.getNetworkHeaders() : {})
            },
            body: JSON.stringify({
                messages: [{ role: "system", content: prompt }, { role: "user", content: storyText }],
                temperature: 0.7
            })
        });
        const data = await response.json();
        const match = data.choices[0].message.content.match(/\[.*\]/s);
        return match ? JSON.parse(match[0]) : null;
    }

    function renderChoices(choices) {
        clearUI();
        const parent = document.getElementById("form_main") || document.body;
        choiceContainer = document.createElement("div");
        choiceContainer.className = "choice-stream-container";
        
        // Apply position
        choiceContainer.style.left = `${settings.offset_left}px`;
        choiceContainer.style.right = `${settings.offset_right}px`;
        if (settings.position === "bottom") {
            choiceContainer.style.bottom = `${settings.offset_bottom}px`;
        } else {
            choiceContainer.style.top = `${settings.offset_top}px`;
        }

        const controls = document.createElement("div");
        controls.className = "choice-stream-controls";
        const closeBtn = document.createElement("button");
        closeBtn.className = "choice-stream-util-btn";
        closeBtn.innerText = "✕";
        closeBtn.onclick = clearUI;
        controls.append(closeBtn);
        choiceContainer.append(controls);

        const box = document.createElement("div");
        box.className = `choice-stream-box choice-stream-layout-${settings.layout}`;

        choices.forEach(text => {
            const btn = document.createElement("button");
            btn.className = "choice-stream-btn";
            btn.innerText = text;
            btn.onclick = () => {
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
        log("UI Rendered on screen.");
    }

    function clearUI() {
        if (choiceContainer) { choiceContainer.remove(); choiceContainer = null; }
    }

    function renderSettingsMenu() {
        if (document.getElementById("cs_active")) return true; // Already rendered
        const target = document.getElementById("extensions_settings") || document.getElementById("extensions_settings2");
        if (!target) return false;

        const html = `
            <div class="inline-drawer"><div class="inline-drawer-header"><b>Choice Stream</b></div>
            <div class="inline-drawer-content">
                <label><input type="checkbox" id="cs_active" ${settings.enabled ? "checked" : ""}> Auto-generate</label><br>
                Options: <input type="number" id="cs_num" value="${settings.numOptions}" style="width:40px">
                Layout: <select id="cs_lay"><option value="row" ${settings.layout=='row'?'selected':''}>Row</option><option value="column" ${settings.layout=='column'?'selected':''}>Col</option></select><br>
                Dock: <select id="cs_pos"><option value="top" ${settings.position=='top'?'selected':''}>Top</option><option value="bottom" ${settings.position=='bottom'?'selected':''}>Bottom</option></select><br>
                L/R: <input type="number" id="cs_l" value="${settings.offset_left}" style="width:40px"> <input type="number" id="cs_r" value="${settings.offset_right}" style="width:40px"><br>
                T/B: <input type="number" id="cs_t" value="${settings.offset_top}" style="width:40px"> <input type="number" id="cs_b" value="${settings.offset_bottom}" style="width:40px"><br>
                <button id="cs_test" class="menu_button">Test UI Rendering</button>
                <button id="cs_manual" class="menu_button">Force AI Gen</button><br>
                <textarea id="cs_prompt" style="width:100%; height:50px; font-size:10px;">${settings.systemPrompt}</textarea>
            </div></div>`;
        
        target.insertAdjacentHTML('beforeend', html);
        
        document.getElementById("cs_active").onchange = (e) => { settings.enabled = e.target.checked; save(); };
        document.getElementById("cs_num").onchange = (e) => { settings.numOptions = e.target.value; save(); };
        document.getElementById("cs_lay").onchange = (e) => { settings.layout = e.target.value; save(); };
        document.getElementById("cs_pos").onchange = (e) => { settings.position = e.target.value; save(); };
        document.getElementById("cs_l").onchange = (e) => { settings.offset_left = e.target.value; save(); };
        document.getElementById("cs_r").onchange = (e) => { settings.offset_right = e.target.value; save(); };
        document.getElementById("cs_t").onchange = (e) => { settings.offset_top = e.target.value; save(); };
        document.getElementById("cs_b").onchange = (e) => { settings.offset_bottom = e.target.value; save(); };
        document.getElementById("cs_test").onclick = () => triggerGeneration(true);
        document.getElementById("cs_manual").onclick = () => triggerGeneration(false);
        return true;
    }

    function save() {
        context.extensionSettings[MODULE_NAME] = settings;
        context.saveSettingsDebounced();
    }

    // Modern SillyTavern Event Loader
    jQuery(() => { init(); });
})();
