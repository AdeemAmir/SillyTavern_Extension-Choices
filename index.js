(function () {
    const MODULE_NAME = "st_choice_stream";
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    let settings = {
        enabled: true,
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

    function loadSettings() {
        if (context.extensionSettings[MODULE_NAME]) {
            settings = Object.assign(settings, context.extensionSettings[MODULE_NAME]);
        }
    }

    async function init() {
        loadSettings();
        setupInputTracker();
        renderSettingsMenu();
        addMagicWandButton();

        // Core Event Hooks
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            if (settings.enabled) triggerGeneration();
        });
        eventSource.on(event_types.MESSAGE_SENT, clearUI);
        eventSource.on(event_types.GENERATION_STARTED, clearUI);
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

    // Add "Generate Choices" to the Magic Wand (Quick Actions) menu
    function addMagicWandButton() {
        const wandMenu = document.getElementById("qr_menu_items");
        if (!wandMenu) return;

        const genButton = document.createElement("div");
        genButton.className = "list-group-item menu_item fa-solid fa-wand-magic-sparkles";
        genButton.innerText = " Generate Story Choices";
        genButton.onclick = () => {
            clearUI();
            triggerGeneration();
        };
        wandMenu.prepend(genButton);
    }

    async function triggerGeneration() {
        const chat = context.chat;
        if (!chat.length || chat[chat.length - 1].is_user) return;

        try {
            const lastText = chat[chat.length - 1].mes;
            const choices = await fetchChoices(lastText);
            if (choices) renderChoices(choices);
        } catch (e) { console.error("Choice Gen Failed", e); }
    }

    async function fetchChoices(storyText) {
        const prompt = settings.systemPrompt.replace("{{numOptions}}", settings.numOptions);
        const response = await fetch("/api/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...context.getNetworkHeaders?.() },
            body: JSON.stringify({
                messages: [{ role: "system", content: prompt }, { role: "user", content: storyText }],
                temperature: 0.7
            })
        });
        const data = await response.json();
        const content = data.choices[0].message.content;
        const match = content.match(/\[.*\]/s);
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
        minBtn.onclick = () => choiceContainer.classList.toggle("choice-stream-minimized");

        const closeBtn = document.createElement("button");
        closeBtn.className = "choice-stream-util-btn";
        closeBtn.innerText = "✕";
        closeBtn.onclick = clearUI;

        controls.append(minBtn, closeBtn);
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
        }
    }

    function renderSettingsMenu() {
        const html = `
            <div class="inline-drawer"><div class="inline-drawer-header"><b>Choice Stream</b></div>
            <div class="inline-drawer-content">
                <label><input type="checkbox" id="cs_active" ${settings.enabled ? "checked" : ""}> Auto-generate Choices</label><br>
                <label>Options: <input type="number" id="cs_num" value="${settings.numOptions}" style="width:50px"></label><br>
                <label>Layout: <select id="cs_lay"><option value="row" ${settings.layout === 'row' ? 'selected' : ''}>Row</option><option value="column" ${settings.layout === 'column' ? 'selected' : ''}>Column</option></select></label><br>
                <label>Dock: <select id="cs_pos"><option value="top" ${settings.position === 'top' ? 'selected' : ''}>Top</option><option value="bottom" ${settings.position === 'bottom' ? 'selected' : ''}>Bottom</option></select></label><br>
                Offsets: L<input type="number" id="cs_l" value="${settings.offset_left}" style="width:40px"> R<input type="number" id="cs_r" value="${settings.offset_right}" style="width:40px"> 
                T<input type="number" id="cs_t" value="${settings.offset_top}" style="width:40px"> B<input type="number" id="cs_b" value="${settings.offset_bottom}" style="width:40px"><br>
                <button id="cs_manual" class="menu_button">Force Generate Now</button><br>
                <textarea id="cs_prompt" style="width:100%; height:60px; font-size:10px;">${settings.systemPrompt}</textarea>
            </div></div>`;
        
        $("#extensions_settings").append(html);
        $("#cs_active").on("change", (e) => { settings.enabled = e.target.checked; save(); });
        $("#cs_num").on("change", (e) => { settings.numOptions = e.target.value; save(); });
        $("#cs_lay").on("change", (e) => { settings.layout = e.target.value; save(); });
        $("#cs_pos").on("change", (e) => { settings.position = e.target.value; save(); });
        $("#cs_l").on("change", (e) => { settings.offset_left = e.target.value; save(); });
        $("#cs_r").on("change", (e) => { settings.offset_right = e.target.value; save(); });
        $("#cs_t").on("change", (e) => { settings.offset_top = e.target.value; save(); });
        $("#cs_b").on("change", (e) => { settings.offset_bottom = e.target.value; save(); });
        $("#cs_prompt").on("input", (e) => { settings.systemPrompt = e.target.value; save(); });
        $("#cs_manual").on("click", triggerGeneration);
    }

    function save() {
        context.extensionSettings[MODULE_NAME] = settings;
        context.saveSettingsDebounced();
        if (choiceContainer) updatePosition();
    }

    SillyTavern.on("app_ready", init);
})();
