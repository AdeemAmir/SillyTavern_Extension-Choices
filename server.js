const fs = require('fs');
const path = require('path');

module.exports = {
    init: function (app) {
        // Updated to the exact filename you requested
        const dbPath = path.join(__dirname, 'choices_db.jsonl');
        const tmpPath = path.join(__dirname, 'choices_db.tmp');

        // Robust, corruption-proof reader
        function getRecords() {
            if (!fs.existsSync(dbPath)) return [];
            try {
                const lines = fs.readFileSync(dbPath, 'utf8').split('\n');
                const validRecords = [];
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;
                    try {
                        validRecords.push(JSON.parse(line));
                    } catch (parseErr) {
                        console.error(`[ST-Choices] Skipped corrupted data on line ${i + 1}. Database protected.`);
                    }
                }
                return validRecords;
            } catch (e) {
                console.error("[ST-Choices] Critical DB Read Error:", e);
                return [];
            }
        }

        // Atomic write to completely prevent database wiping on power-loss
        function atomicWrite(records) {
            const content = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
            fs.writeFileSync(tmpPath, content, 'utf8');
            fs.renameSync(tmpPath, dbPath); // Instant OS-level swap
        }

        // Endpoint: Append a new record (Pass or Fail)
        app.post('/api/extensions/st_choice_stream/log', (req, res) => {
            try {
                const data = req.body;
                if (!data) return res.status(400).json({ error: "Missing payload" });

                const records = getRecords();

                const global_id = records.length > 0 ? records[records.length - 1].global_id + 1 : 1;
                const chatRecords = records.filter(r => r.chat_id === data.chat_id);
                const chat_num = chatRecords.length > 0 ? chatRecords[chatRecords.length - 1].chat_num + 1 : 1;

                data.global_id = global_id;
                data.chat_num = chat_num;

                // Append safely line-by-line
                fs.appendFileSync(dbPath, JSON.stringify(data) + '\n', 'utf8');
                console.log(`[ST-Choices] Successfully saved generation ID: ${global_id}`);
                res.json({ success: true, global_id, chat_num });
            } catch (e) {
                console.error("[ST-Choices] DB Write Error:", e);
                res.status(500).json({ error: e.toString() });
            }
        });

        // Endpoint: Fetch the entire dataset
        app.get('/api/extensions/st_choice_stream/db', (req, res) => {
            try {
                res.json(getRecords());
            } catch (e) {
                res.status(500).json({ error: e.toString() });
            }
        });

        // Endpoint: Delete a single record by Global ID
        app.post('/api/extensions/st_choice_stream/delete', (req, res) => {
            try {
                const targetId = req.body.global_id;
                let records = getRecords();
                records = records.filter(r => r.global_id !== targetId);
                atomicWrite(records);
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.toString() });
            }
        });

        // Endpoint: Wipe database completely
        app.post('/api/extensions/st_choice_stream/clear', (req, res) => {
            try {
                atomicWrite([]);
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.toString() });
            }
        });
    }
};