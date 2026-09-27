const MD_JSON_START = ['\x60', '\x60', '\x60', 'json'].join('');

export const DEFAULT_SETTINGS = {
    // Switch to "local" before pushing to GitHub for zero-setup users.
    storageMode: 'server', 
    custom_db_path: '',
    
    enabled: true,
    includeSummary: true,
    dynamicMatrix: true,
    skipInterrupted: true,
    debugMode: 2,           
    numOptions: 5,
    generationDelay: 0,     
    layout: "column",
    position: "bottom",
    offset_top: 10,
    offset_bottom: 50,
    
    // Expanded Data Logging
    store_ai_context: true,
    store_summary: true,
    store_instruction_prompt: true,
    store_custom_direction: true,
    store_raw_response: true,
    
    // Resizing
    widget_width: 90, 
    choice_block_max_height: 40,
    modal_width: 95,
    modal_height: 90,

    instructionPrompt: `[System Note: TASK: Analyze the story context and the summary.\n\n{{matrix_block}}\n\nCRITICAL RULES:\n1. Length: Choices MUST be highly detailed, paragraph-length continuations (at least 3 to 5 sentences long).\n2. Content: Include specific immediate actions, rich sensory details, and dialogue. Stay in the immediate present scene. NO time-skips.\n3. JSON Format: Output ONLY a valid JSON array of objects.\n4. Keys: Each object MUST contain EXACTLY ONE key named "choice".\n5. The value of "choice" MUST be the actual narrative paragraph. DO NOT put numbers here. DO NOT add keys for descriptions, reasoning, or titles.\n\nExample format:\n[\n  {"choice": "I slowly back away from the door, my heart hammering against my ribs as the realization sets in. 'We can't stay here,' I whisper, grabbing my coat from the chair. Without waiting for a response, I move to the window, scanning the dark treeline for any sign of movement while frantically trying to piece together a new escape plan."},\n  {"choice": "Another highly detailed narrative paragraph goes here..."}\n]\n\nYou MUST wrap your output in a ${MD_JSON_START} codeblock. Open the codeblock immediately.]`,
    
    matrix: [
        { range: "1-2", text: "A highly detailed, logical continuation that realistically advances the current immediate scene." },
        { range: "3-4", text: "A deeply immersive continuation tailored specifically to match the narrative tone." },
        { range: "5", text: "A wildcard scenario shift introducing a sudden, unexpected action or detailed dialogue that drastically changes the immediate situation." }
    ]
};