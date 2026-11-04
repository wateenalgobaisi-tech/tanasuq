const express = require('express');
const path = require('path');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('لم يتم العثور على نتيجة');
  return JSON.parse(text.slice(start, end + 1));
}

app.post('/api/generate-look', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'الطلب فارغ' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'المفتاح ANTHROPIC_API_KEY غير مضاف في الإعدادات' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'خطأ من الخدمة' });

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    res.json(extractJson(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on ' + PORT));
