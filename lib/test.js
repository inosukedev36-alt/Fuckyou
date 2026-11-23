import { askGemini } from './gemini.js';

const r = await askGemini('ඔයා ගැන විස්ටර කියන්න ', { language: 'si' });
console.log(r.text);
