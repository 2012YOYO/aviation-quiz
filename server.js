/**
 * 航空知识测验 - 后端服务
 * 功能：短信验证码 + 用户管理 + 答题历史 + 标记同步
 *
 * 存储方案：
 * - 生产环境（Vercel）：Upstash Redis（通过环境变量自动连接）
 * - 本地开发：JSON 文件（data.json，自动创建）
 *
 * 使用说明：
 * 1. 安装依赖：npm install express cors @upstash/redis
 * 2. 运行服务：node server.js
 * 3. 服务默认运行在 http://localhost:3000
 *
 * 启用云端存储（Upstash Redis）：
 *   在 Vercel 项目设置中添加环境变量：
 *   UPSTASH_REDIS_REST_URL=your_url
 *   UPSTASH_REDIS_REST_TOKEN=your_token
 *   或在 Upstash 控制台创建 Redis 数据库后填入
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// 挂载静态文件
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'aviation_quiz.html'));
});

// ===== 存储层 =====
let redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('[存储] 使用 Upstash Redis（云端）');
  }
} catch(e) {
  console.log('[存储] Upstash Redis 不可用，使用本地文件');
}

const LOCAL_DATA_FILE = path.join(__dirname, 'data.json');

function readLocalData() {
  try {
    if (fs.existsSync(LOCAL_DATA_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, 'utf-8'));
    }
  } catch(e) {}
  return {};
}

function writeLocalData(data) {
  try {
    fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(data, null, 2));
  } catch(e) {
    console.error('[存储] 写入本地文件失败:', e);
  }
}

const store = {
  async get(key) {
    if (redis) {
      const val = await redis.get(key);
      return val;
    }
    const data = readLocalData();
    return data[key] !== undefined ? data[key] : null;
  },

  async set(key, value) {
    if (redis) {
      await redis.set(key, value);
      return;
    }
    const data = readLocalData();
    data[key] = value;
    writeLocalData(data);
  },

  async keys(pattern) {
    if (redis) {
      return await redis.keys(pattern);
    }
    const data = readLocalData();
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Object.keys(data).filter(k => regex.test(k));
  },

  async delete(key) {
    if (redis) {
      await redis.del(key);
      return;
    }
    const data = readLocalData();
    delete data[key];
    writeLocalData(data);
  }
};

// ===== 短信验证码配置 =====
const CONFIG = {
  aliAccessKeyId:     process.env.ALI_ACCESS_KEY_ID     || '',
  aliAccessKeySecret: process.env.ALI_ACCESS_KEY_SECRET || '',
  aliSignName:        process.env.ALI_SIGN_NAME         || '',
  aliTemplateCode:    process.env.ALI_TEMPLATE_CODE     || '',
};

const isMockMode = !CONFIG.aliAccessKeyId || !CONFIG.aliAccessKeySecret ||
                   !CONFIG.aliSignName     || !CONFIG.aliTemplateCode;

const SMS_SECRET = process.env.SMS_SECRET || 'aerospace-quiz-default-secret-key-2026';

// 内存验证码存储（本地开发兼容）
const codes = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [phone, record] of codes) {
    if (now > record.expire) codes.delete(phone);
  }
}, 10 * 60 * 1000);

// ===== 无状态签名验证码 =====
function generateSignedCode(phone) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const timestamp = Date.now();
  const payload = `${phone}:${code}:${timestamp}`;
  const signature = crypto.createHmac('sha256', SMS_SECRET).update(payload).digest('hex');
  return { code, timestamp, signature };
}

function verifySignedCode(phone, code, timestamp, signature) {
  const payload = `${phone}:${code}:${timestamp}`;
  const expected = crypto.createHmac('sha256', SMS_SECRET).update(payload).digest('hex');
  if (signature !== expected) return false;
  if (Date.now() - timestamp > 5 * 60 * 1000) return false;
  return true;
}

// ===== 阿里云短信 =====
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function aliSign(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  let canonicalStr = '';
  for (const k of sortedKeys) {
    canonicalStr += '&' + percentEncode(k) + '=' + percentEncode(params[k]);
  }
  canonicalStr = canonicalStr.slice(1);
  const stringToSign = 'GET&' + percentEncode('/') + '&' + percentEncode(canonicalStr);
  return crypto.createHmac('sha1', secret + '&').update(stringToSign).digest('base64');
}

async function sendAliSms(phone, code) {
  const params = {
    RegionId: 'cn-hangzhou', Action: 'SendSms', Version: '2017-05-25',
    PhoneNumbers: phone, SignName: CONFIG.aliSignName, TemplateCode: CONFIG.aliTemplateCode,
    TemplateParam: JSON.stringify({ code }), OutId: Date.now().toString(),
    AccessKeyId: CONFIG.aliAccessKeyId, SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0', SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d+Z/, 'Z'), Format: 'JSON',
  };
  params.Signature = aliSign(params, CONFIG.aliAccessKeySecret);
  const url = new URL('https://dysmsapi.aliyuncs.com');
  for (const [k, v] of Object.entries(params)) { url.searchParams.set(k, v); }
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.Code !== 'OK') { throw new Error(data.Message || '短信发送失败'); }
  return data;
}

// ===== 短信 API =====
app.post('/send-sms', async (req, res) => {
  const { phone } = req.body;
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, message: '手机号格式错误' });
  }
  const { code, timestamp, signature } = generateSignedCode(phone);
  codes.set(phone, { code, expire: Date.now() + 5 * 60 * 1000 });
  try {
    if (isMockMode) {
      console.log(`\n===== 模拟短信 =====`);
      console.log(`  发送至: ${phone}`);
      console.log(`  验证码: ${code}`);
      console.log(`====================\n`);
      return res.json({ success: true, message: '验证码已发送', mock: true, code, timestamp, signature });
    }
    await sendAliSms(phone, code);
    res.json({ success: true, message: '验证码已发送至您的手机', timestamp, signature });
  } catch (err) {
    console.error('短信发送失败:', err);
    res.status(500).json({ success: false, message: '短信发送失败: ' + err.message });
  }
});

app.post('/verify-sms', (req, res) => {
  const { phone, code, timestamp, signature } = req.body;
  if (timestamp && signature) {
    if (verifySignedCode(phone, code, timestamp, signature)) {
      return res.json({ success: true, message: '验证成功' });
    }
    return res.json({ success: false, message: '验证码错误或已过期' });
  }
  const record = codes.get(phone);
  if (!record) { return res.json({ success: false, message: '请先发送验证码' }); }
  if (Date.now() > record.expire) {
    codes.delete(phone);
    return res.json({ success: false, message: '验证码已过期' });
  }
  if (record.code !== code) { return res.json({ success: false, message: '验证码错误' }); }
  codes.delete(phone);
  res.json({ success: true, message: '验证成功' });
});

// ===== 用户管理 API =====
const ADMIN_PHONE = '13800000000';

// 注册
app.post('/api/register', async (req, res) => {
  const { phone, username, password } = req.body;
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.json({ success: false, message: '手机号格式错误' });
  }
  if (!username || username.length < 2 || username.length > 16) {
    return res.json({ success: false, message: '用户名长度应为2-16位' });
  }
  if (!password || password.length < 6 || password.length > 20) {
    return res.json({ success: false, message: '密码长度应为6-20位' });
  }

  try {
    // 检查手机号是否已注册
    const existing = await store.get(`user:${phone}`);
    if (existing) {
      return res.json({ success: false, message: '该手机号已注册' });
    }

    // 检查用户名是否已被占用
    const allUserKeys = await store.keys('user:*');
    for (const key of allUserKeys) {
      const u = await store.get(key);
      if (u && u.username === username) {
        return res.json({ success: false, message: '该用户名已被使用' });
      }
    }

    const userData = {
      phone, username, password,
      createdAt: new Date().toISOString()
    };
    await store.set(`user:${phone}`, userData);
    res.json({ success: true, message: '注册成功', user: { phone, username, createdAt: userData.createdAt } });
  } catch(e) {
    console.error('注册失败:', e);
    res.json({ success: false, message: '服务器错误: ' + e.message });
  }
});

// 密码登录
app.post('/api/login-pwd', async (req, res) => {
  const { username, password } = req.body;

  // 管理员快捷登录
  if (username === 'admin' && password === 'admin123') {
    const adminData = {
      phone: ADMIN_PHONE, username: 'admin', password: 'admin123',
      createdAt: new Date().toISOString()
    };
    await store.set(`user:${ADMIN_PHONE}`, adminData);
    return res.json({ success: true, user: { phone: ADMIN_PHONE, username: 'admin', createdAt: adminData.createdAt } });
  }

  try {
    const allUserKeys = await store.keys('user:*');
    for (const key of allUserKeys) {
      const u = await store.get(key);
      if (u && u.username === username && u.password === password) {
        return res.json({ success: true, user: { phone: u.phone, username: u.username, createdAt: u.createdAt } });
      }
    }
    res.json({ success: false, message: '用户名或密码错误' });
  } catch(e) {
    console.error('密码登录失败:', e);
    res.json({ success: false, message: '服务器错误' });
  }
});

// 按手机号查询用户（验证码登录后检查是否已注册）
app.get('/api/user/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const user = await store.get(`user:${phone}`);
    if (user && user.username) {
      res.json({ success: true, user: { phone: user.phone, username: user.username, createdAt: user.createdAt } });
    } else {
      res.json({ success: false, message: '该手机号未注册' });
    }
  } catch(e) {
    res.json({ success: false, message: '服务器错误' });
  }
});

// 获取所有用户（管理员面板用）
app.get('/api/users', async (req, res) => {
  try {
    const allUserKeys = await store.keys('user:*');
    const users = [];
    for (const key of allUserKeys) {
      const u = await store.get(key);
      if (u) {
        users.push({
          phone: u.phone,
          username: u.username,
          createdAt: u.createdAt
        });
      }
    }
    res.json({ success: true, users });
  } catch(e) {
    console.error('获取用户列表失败:', e);
    res.json({ success: false, users: [], message: '服务器错误' });
  }
});

// ===== 答题历史 API =====
app.get('/api/history/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const history = await store.get(`history:${phone}`);
    res.json({ success: true, history: history || [] });
  } catch(e) {
    res.json({ success: true, history: [] });
  }
});

app.post('/api/history/:phone', async (req, res) => {
  const { phone } = req.params;
  const { history } = req.body;
  try {
    await store.set(`history:${phone}`, history);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, message: '保存失败' });
  }
});

// ===== 标记题目 API =====
app.get('/api/marks/:phone', async (req, res) => {
  const { phone } = req.params;
  try {
    const marks = await store.get(`marks:${phone}`);
    res.json({ success: true, marks: marks || [] });
  } catch(e) {
    res.json({ success: true, marks: [] });
  }
});

app.post('/api/marks/:phone', async (req, res) => {
  const { phone } = req.params;
  const { marks } = req.body;
  try {
    await store.set(`marks:${phone}`, marks);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, message: '保存失败' });
  }
});

// 健康检查
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    service: '航空知识测验 · 后端服务',
    smsMode: isMockMode ? 'mock' : 'real',
    storage: redis ? 'upstash-redis' : 'local-file',
    endpoints: {
      'POST /send-sms': '发送验证码',
      'POST /verify-sms': '验证验证码',
      'POST /api/register': '注册',
      'POST /api/login-pwd': '密码登录',
      'GET /api/user/:phone': '查询用户',
      'GET /api/users': '所有用户',
      'GET/POST /api/history/:phone': '答题历史',
      'GET/POST /api/marks/:phone': '标记题目',
    }
  });
});

// 导出 app
module.exports = app;

// 本地开发启动
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  航空知识测验后端服务已启动`);
    console.log(`  地址: http://localhost:${PORT}`);
    console.log(`  短信: ${isMockMode ? '模拟模式' : '真实模式（阿里云）'}`);
    console.log(`  存储: ${redis ? 'Upstash Redis' : '本地文件 (data.json)'}`);
    console.log(`========================================\n`);
  });
}
