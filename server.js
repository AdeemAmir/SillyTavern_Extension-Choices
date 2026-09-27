const fs = require('fs');
const path = require('path');

module.exports = {
    init: function (app) {
        // The DB file will live directly in your extension folder
        const dbPath = path.join(__dirname, 'choices_db.jsonl');

        function getRecords() {
            if (!fs.existsSync(dbPath)) return [];
            try {
                return fs.readFileSync(dbPath, 'utf8')
                    .split('\n')
                    .filter(line => line.trim())
                    .map(line => JSON.parse(line));
            } catch (e) {
                console.error("[ST-Choices] DB Read Error:", e);
                return [];
            }
        }

        // Endpoint: Append a new record (Pass or Fail)
        app.post('/api/extensions/st_choice_stream/log', (req, res) => {
            try {
                const data = req.body;
                const records = getRecords();

                // Calculate Global Numeration & Chat-Specific Numeration
                const global_id = records.length > 0 ? records[records.length - 1].global_id + 1 : 1;
                const chatRecords = records.filter(r => r.chat_id === data.chat_id);
                const chat_num = chatRecords.length > 0 ? chatRecords[chatRecords.length - 1].chat_num + 1 : 1;

                data.global_id = global_id;
                data.chat_num = chat_num;

                // Append purely, highly performant for 100s of MBs
                fs.appendFileSync(dbPath, JSON.stringify(data) + '\n', 'utf8');
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
                
                // Rewrite the file without the deleted record
                fs.writeFileSync(dbPath, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.toString() });
            }
        });

        // Endpoint: Wipe database completely
        app.post('/api/extensions/st_choice_stream/clear', (req, res) => {
            try {
                fs.writeFileSync(dbPath, '', 'utf8');
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.toString() });
            }
        });
    }
};