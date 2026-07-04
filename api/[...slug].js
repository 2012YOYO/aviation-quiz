// Vercel Serverless Function - Catch-all API handler
// 自动处理所有 /api/* 请求，无需 vercel.json rewrites
const app = require('../server.js');

module.exports = app;
