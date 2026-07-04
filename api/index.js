// Vercel Serverless Function 入口
// 将所有请求转发给 Express 应用
// @vercel/node 会保留原始请求路径（req.url），Express 路由能正确匹配
module.exports = require('../server.js');
