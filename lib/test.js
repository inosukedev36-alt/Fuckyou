import { askGemini } from './gemini.mjs';

const r = await askGemini('ඔයා ගැන විස්ටර කියන්න ', { language: 'si' });
console.log(r.text);
