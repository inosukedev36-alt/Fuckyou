import { askGemini } from './gemini.js';

const r = await askGemini('Say hi in Sinhala', { language: 'si' });
console.log(r.text);
