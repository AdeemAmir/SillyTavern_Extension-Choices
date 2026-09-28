const fs = require('fs');
const path = require('path');

module.exports = {
    info: {
        id: 'sillytavern_extension-choices',
        name: 'Choice Stream Database',
        description: 'Permanent JSONL logging backend for the Choice Stream extension.'
    },
    init: async function (router) {
        console.log("[ST-Choices] Backend Database Router successfully loaded!");

        function getDbPath(req) {
            const customPath = (req.body && req.body.db_path) || (req.query && req.query.db_path);
            if (customPath && customPath.trim() !== "") {
                const dir = path.dirname(customPath.trim());
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                return customPath.trim();
            }
            const defaultDbDir = path.join(process.cwd(), 'data', 'default-user', '_db', 'choices_db');
            if (!fs.existsSync(defaultDbDir)) fs.mkdirSync(defaultDbDir, { recursive: true });
            return path.join(defaultDbDir, 'choices_db.jsonl');
        }

        function getRecords(dbPath) {
            if (!fs.existsSync(dbPath)) return [];
            try {
                const lines = fs.readFileSync(dbPath, 'utf8').split('\n');
                const validRecords = [];
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;
                    try { validRecords.push(JSON.parse(line)); } 
                    catch (parseErr) { console.error(`[ST-Choices] Skipped corrupted DB data on line ${i + 1}.`); }
                }
                return validRecords;
            } catch (e) {
                console.error("[ST-Choices] Critical DB Read Error:", e);
                return [];
            }
        }

        function atomicWrite(records, dbPath) {
            const tmpPath = dbPath + '.tmp';
            // Explicitly build the object in the exact requested order
            const content = records.map(data => JSON.stringify({
                id: data.id,
                chara_name: data.chara_name || "Unknown_Character",
                chat_name: data.chat_name || "Unknown_Chat",
                global_num: data.global_num,
                chat_num: data.chat_num,
                status: data.status,
                ai_context: data.ai_context || "",
                story_summary: data.story_summary || "",
                custom_direction: data.custom_direction || "",
                data: data.data || ""
            })).join('\n') + (records.length ? '\n' : '');
            
            fs.writeFileSync(tmpPath, content, 'utf8');
            fs.renameSync(tmpPath, dbPath); 
        }

        router.post('/log', (req, res) => {
            try {
                const payload = req.body;
                if (!payload || !payload.id) return res.status(400).json({ error: "Missing payload" });

                const dbPath = getDbPath(req);
                const records = getRecords(dbPath);
                
                const global_num = records.length > 0 ? records[records.length - 1].global_num + 1 : 1;
                const chatRecords = records.filter(r => r.chat_name === payload.chat_name);
                const chat_num = chatRecords.length > 0 ? chatRecords[chatRecords.length - 1].chat_num + 1 : 1;

                // 1. Strict Schema Order Enforced Here
                const orderedData = {
                    id: payload.id,
                    chara_name: payload.chara_name || "Unknown_Character",
                    chat_name: payload.chat_name || "Unknown_Chat",
                    global_num: global_num,
                    chat_num: chat_num,
                    status: payload.status,
                    ai_context: payload.ai_context || "",
                    story_summary: payload.story_summary || "",
                    custom_direction: payload.custom_direction || "",
                    data: payload.data || ""
                };

                fs.appendFileSync(dbPath, JSON.stringify(orderedData) + '\n', 'utf8');
                res.json({ success: true, id: orderedData.id, global_num, chat_num });
            } catch (e) {
                console.error("[ST-Choices] DB Write Error:", e);
                res.status(500).json({ error: e.toString() });
            }
        });

        router.get('/db', (req, res) => {
            try { res.json(getRecords(getDbPath(req))); } 
            catch (e) { res.status(500).json({ error: e.toString() }); }
        });

        router.post('/delete', (req, res) => {
            try {
                const dbPath = getDbPath(req);
                const targetId = req.body.id;
                let records = getRecords(dbPath);
                records = records.filter(r => r.id !== targetId);
                atomicWrite(records, dbPath);
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.toString() });
            }
        });

        router.post('/clear', (req, res) => {
            try {
                const dbPath = getDbPath(req);
                const type = req.body.type || "ALL";
                if (type === "ALL") {
                    atomicWrite([], dbPath);
                } else {
                    let records = getRecords(dbPath);
                    records = records.filter(r => r.status !== type);
                    atomicWrite(records, dbPath);
                }
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.toString() });
            }
        });

        router.post('/import', (req, res) => {
            try {
                const dbPath = getDbPath(req);
                const newRecords = req.body.records || [];
                const currentRecords = getRecords(dbPath);
                
                let currentGlobal = currentRecords.length > 0 ? currentRecords[currentRecords.length - 1].global_num : 0;
                let writeBuffer = "";
                
                for(let payload of newRecords) {
                    currentGlobal++;
                    const chatRecords = currentRecords.filter(r => r.chat_name === payload.chat_name);
                    const chat_num = chatRecords.length > 0 ? chatRecords[chatRecords.length - 1].chat_num + 1 : 1;
                    
                    const orderedData = {
                        id: payload.id,
                        chara_name: payload.chara_name || "Unknown_Character",
                        chat_name: payload.chat_name || "Unknown_Chat",
                        global_num: currentGlobal,
                        chat_num: chat_num,
                        status: payload.status,
                        ai_context: payload.ai_context || "",
                        story_summary: payload.story_summary || "",
                        custom_direction: payload.custom_direction || "",
                        data: payload.data || ""
                    };
                    
                    currentRecords.push(orderedData); 
                    writeBuffer += JSON.stringify(orderedData) + '\n';
                }
                
                if (writeBuffer) fs.appendFileSync(dbPath, writeBuffer, 'utf8');
                res.json({ success: true, count: newRecords.length });
            } catch (e) {
                res.status(500).json({ error: e.toString() });
            }
        });

        return Promise.resolve();
    }
};