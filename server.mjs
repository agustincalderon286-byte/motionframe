import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { MongoClient, ObjectId } from 'mongodb';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data'), UPLOADS = path.join(ROOT, 'uploads');
const STATE_FILE = path.join(DATA, 'state.json');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const KIE_API_KEY = (process.env.KIE_API_KEY || '').trim();
const KIE_API_ROOT = 'https://api.kie.ai';
const KIE_UPLOAD_ROOT = 'https://kieai.redpandaai.co';
const CALLBACK_SECRET = (process.env.KIE_CALLBACK_SECRET || '').trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();
const SESSION_DAYS = 30;
const MIN_CLIP_SECONDS = 3;
const MAX_CLIP_SECONDS = 10;
const scryptAsync = promisify(scrypt);
const STRIPE_PACKS = [
  { id: 'starter', name: 'Starter — $20', description: '2 clips up to 10 seconds at 720p', credits: Number(process.env.STRIPE_STARTER_CREDITS || 20), priceId: (process.env.STRIPE_PRICE_STARTER || '').trim() },
  { id: 'creator', name: 'Creator — $50', description: '6 clips up to 10 seconds at 720p', credits: Number(process.env.STRIPE_CREATOR_CREDITS || 60), priceId: (process.env.STRIPE_PRICE_CREATOR || '').trim() },
].filter(pack => Number.isSafeInteger(pack.credits) && pack.credits > 0);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime']);
const MIME = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

await mkdir(DATA, { recursive: true }); await mkdir(UPLOADS, { recursive: true });
let state = await loadState();
let database = null;
if (MONGODB_URI) {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect(); database = client.db(process.env.MONGODB_DB || 'motionframe');
  await Promise.all([
    database.collection('users').createIndex({ email: 1 }, { unique: true }),
    database.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('stripeEvents').createIndex({ eventId: 1 }, { unique: true }),
    database.collection('jobs').createIndex({ userId: 1, createdAt: -1 }),
  ]);
}
async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); }
  catch { return { account: { credits: Number(process.env.STARTING_CREDITS || 0) }, jobs: {}, stripeEvents: {} }; }
}
let saving = Promise.resolve();
function persist() { saving = saving.then(async () => { const tmp = `${STATE_FILE}.tmp`; await writeFile(tmp, JSON.stringify(state, null, 2)); await rename(tmp, STATE_FILE); }); return saving; }
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const error = (res, status, message) => json(res, status, { error: message });
const creditsFor = quality => quality === '1080p' ? 20 : 10;
const publicJob = (job, credits = state.account.credits) => ({ id: job.id, status: job.status, message: job.message, error: job.error, progress: job.progress, outputUrl: job.outputUrl, demo: job.demo, credits });
function safeEqual(one, two) { if (!one || !two) return false; const a = Buffer.from(one), b = Buffer.from(two); return a.length === b.length && timingSafeEqual(a, b); }
function cookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => item.trim().split('=').map(decodeURIComponent)).filter(([key]) => key)); }
function sessionHash(token) { return createHmac('sha256', SESSION_SECRET).update(token).digest('hex'); }
function configuredAccounts() { return Boolean(database && SESSION_SECRET.length >= 32); }
async function hashPassword(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${(await scryptAsync(password, salt, 64)).toString('hex')}`; }
async function passwordMatches(password, stored) { const [salt, expected] = String(stored || '').split(':'); if (!salt || !expected) return false; return safeEqual((await hashPassword(password, salt)).split(':')[1], expected); }
function cookie(res, name, value, maxAge = SESSION_DAYS * 86400) { res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${PUBLIC_BASE_URL.startsWith('https://') ? '; Secure' : ''}`); }
async function currentUser(req) {
  if (!configuredAccounts()) return null;
  const token = cookies(req).motionframe_session; if (!token) return null;
  const session = await database.collection('sessions').findOne({ tokenHash: sessionHash(token), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  return database.collection('users').findOne({ _id: session.userId }, { projection: { passwordHash: 0 } });
}
function publicUser(user) { return { id: String(user._id), email: user.email, credits: user.credits }; }
async function startSession(res, userId) { const token = randomBytes(32).toString('base64url'); await database.collection('sessions').insertOne({ userId, tokenHash: sessionHash(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400 * 1000) }); cookie(res, 'motionframe_session', token); }
async function signUp(req, res) {
  try { if (!configuredAccounts()) throw new Error('Accounts are not configured yet.'); const { email, password } = await jsonBody(req); const cleanEmail = String(email || '').trim().toLowerCase(), cleanPassword = String(password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Enter a valid email address.'); if (cleanPassword.length < 10) throw new Error('Use at least 10 characters for your password.');
    const user = { email: cleanEmail, passwordHash: await hashPassword(cleanPassword), credits: Number(process.env.STARTING_CREDITS || 0), createdAt: new Date() };
    const created = await database.collection('users').insertOne(user); user._id = created.insertedId; await startSession(res, user._id); json(res, 201, { user: publicUser(user) });
  } catch (e) { error(res, e?.code === 11000 ? 409 : 400, e?.code === 11000 ? 'An account already exists for this email.' : e.message); }
}
async function signIn(req, res) {
  try { if (!configuredAccounts()) throw new Error('Accounts are not configured yet.'); const { email, password } = await jsonBody(req); const user = await database.collection('users').findOne({ email: String(email || '').trim().toLowerCase() });
    if (!user || !(await passwordMatches(String(password || ''), user.passwordHash))) throw new Error('Email or password is incorrect.'); await startSession(res, user._id); json(res, 200, { user: publicUser(user) });
  } catch (e) { error(res, 401, e.message); }
}
async function signOut(req, res) { if (configuredAccounts()) { const token = cookies(req).motionframe_session; if (token) await database.collection('sessions').deleteOne({ tokenHash: sessionHash(token) }); } cookie(res, 'motionframe_session', '', 0); json(res, 200, { ok: true }); }
function requestOrigin(req) { return PUBLIC_BASE_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`; }
function stripeReady() { return Boolean(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET && PUBLIC_BASE_URL && STRIPE_PACKS.some(pack => pack.priceId)); }
async function rawBody(req, limit = 1024 * 1024) { const chunks = []; let total = 0; for await (const chunk of req) { total += chunk.length; if (total > limit) throw new Error('Request body is too large.'); chunks.push(chunk); } return Buffer.concat(chunks); }
async function jsonBody(req) { const body = await rawBody(req); try { return JSON.parse(body.toString('utf8') || '{}'); } catch { throw new Error('Invalid JSON body.'); } }
function stripeSignatureIsValid(payload, signature) {
  if (!STRIPE_WEBHOOK_SECRET || !signature) return false;
  const values = Object.fromEntries(signature.split(',').map(item => item.split('=', 2)));
  const timestamp = Number(values.t); if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${payload.toString('utf8')}`).digest('hex');
  return safeEqual(expected, values.v1);
}
async function createCheckout(req, res) {
  try {
    if (!stripeReady() || !configuredAccounts()) throw new Error('Checkout is not configured yet.');
    const user = await currentUser(req); if (!user) return error(res, 401, 'Please sign in to buy credits.');
    const body = await jsonBody(req), pack = STRIPE_PACKS.find(item => item.id === body.pack && item.priceId);
    if (!pack) throw new Error('That credit pack is unavailable.');
    const form = new URLSearchParams({ mode: 'payment', success_url: `${requestOrigin(req)}/?checkout=success`, cancel_url: `${requestOrigin(req)}/?checkout=cancel`, 'line_items[0][price]': pack.priceId, 'line_items[0][quantity]': '1', 'metadata[pack_id]': pack.id, 'metadata[credits]': String(pack.credits), 'metadata[user_id]': String(user._id), customer_email: user.email });
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${STRIPE_SECRET_KEY}:`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    const session = await response.json(); if (!response.ok || !session.url) throw new Error(session?.error?.message || 'Stripe could not create checkout.');
    json(res, 200, { url: session.url });
  } catch (e) { error(res, 400, e.message); }
}
async function stripeWebhook(req, res) {
  try {
    const payload = await rawBody(req); if (!stripeSignatureIsValid(payload, req.headers['stripe-signature'])) return error(res, 400, 'Invalid Stripe signature.');
    const event = JSON.parse(payload.toString('utf8'));
    if (!configuredAccounts()) return error(res, 503, 'Accounts are not configured.');
    if (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') {
      const credits = Number(event.data.object.metadata?.credits), packId = event.data.object.metadata?.pack_id, userId = event.data.object.metadata?.user_id;
      const pack = STRIPE_PACKS.find(item => item.id === packId && item.credits === credits);
      if (!pack) return error(res, 400, 'Unknown credit pack.');
      const recorded = await database.collection('stripeEvents').updateOne({ eventId: event.id }, { $setOnInsert: { eventId: event.id, credits, userId, receivedAt: new Date(), sessionId: event.data.object.id } }, { upsert: true });
      if (recorded.upsertedCount) await database.collection('users').updateOne({ _id: new ObjectId(userId) }, { $inc: { credits } });
    }
    json(res, 200, { received: true });
  } catch (e) { error(res, 400, e.message); }
}
function setJobStatus(job, patch) { Object.assign(job, patch, { updatedAt: new Date().toISOString() }); return database && job.userId ? database.collection('jobs').updateOne({ id: job.id, userId: job.userId }, { $set: patch }) : persist(); }
function fileExtension(file) { return path.extname(file.name).toLowerCase() || (file.type === 'image/png' ? '.png' : file.type === 'video/quicktime' ? '.mov' : file.type.startsWith('image/') ? '.jpg' : '.mp4'); }
async function validUpload(file, types, limit, label) {
  if (!(file instanceof File) || !types.has(file.type)) throw new Error(`${label} must be a supported file type.`);
  if (!file.size || file.size > limit) throw new Error(`${label} exceeds the maximum permitted size.`);
  const header = Buffer.from(await file.slice(0, 12).arrayBuffer());
  const isPng = header.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpeg = header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isMp4 = header.subarray(4, 8).equals(Buffer.from('ftyp'));
  if ((file.type.startsWith('image/') && !isPng && !isJpeg) || (file.type.startsWith('video/') && !isMp4)) throw new Error(`${label} file content is not valid.`);
}
function boxHeader(bytes, offset, limit) {
  if (offset + 8 > limit) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(offset), headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    size = Number(view.getBigUint64(offset + 8)); headerSize = 16;
  }
  if (!size) size = limit - offset;
  if (size < headerSize || offset + size > limit) return null;
  return { type: String.fromCharCode(...bytes.slice(offset + 4, offset + 8)), start: offset, end: offset + size, data: offset + headerSize };
}
async function videoDurationSeconds(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let offset = 0, movie;
  while (offset < bytes.length) {
    const box = boxHeader(bytes, offset, bytes.length); if (!box) break;
    if (box.type === 'moov') { movie = box; break; }
    offset = box.end;
  }
  if (!movie) throw new Error('We could not verify the duration of this motion video.');
  offset = movie.data;
  while (offset < movie.end) {
    const box = boxHeader(bytes, offset, movie.end); if (!box) break;
    if (box.type === 'mvhd') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), version = view.getUint8(box.data);
      const timescaleOffset = box.data + (version === 1 ? 20 : 12), durationOffset = box.data + (version === 1 ? 24 : 16);
      if (durationOffset + (version === 1 ? 8 : 4) > box.end) break;
      const timescale = view.getUint32(timescaleOffset);
      const duration = version === 1 ? Number(view.getBigUint64(durationOffset)) : view.getUint32(durationOffset);
      if (timescale > 0 && Number.isFinite(duration)) return duration / timescale;
      break;
    }
    offset = box.end;
  }
  throw new Error('We could not verify the duration of this motion video.');
}
async function parseForm(req) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > 115 * 1024 * 1024) throw new Error('The total upload is too large.');
  const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: Readable.toWeb(req), duplex: 'half' });
  return request.formData();
}
async function saveFile(file, jobId, type) {
  const name = `${jobId}-${type}${fileExtension(file)}`;
  const destination = path.join(UPLOADS, name);
  await writeFile(destination, Buffer.from(await file.arrayBuffer()), { flag: 'wx' });
  return destination;
}
async function requestKie(url, options, action) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false || (payload.code && payload.code !== 200)) throw new Error(payload.msg || payload.message || `KIE failed during ${action}.`);
    return payload;
  } finally { clearTimeout(timer); }
}
async function uploadToKie(filePath, type) {
  const bytes = await readFile(filePath), extension = path.extname(filePath), name = `${randomUUID()}${extension}`;
  const form = new FormData();
  form.append('file', new Blob([bytes]), name); form.append('uploadPath', `motionframe/${type}`); form.append('fileName', name);
  const payload = await requestKie(`${KIE_UPLOAD_ROOT}/api/file-stream-upload`, { method: 'POST', headers: { Authorization: `Bearer ${KIE_API_KEY}` }, body: form }, 'file upload');
  const url = payload?.data?.downloadUrl || payload?.data?.fileUrl;
  if (!url) throw new Error('KIE accepted the file but did not provide a file URL.');
  return url;
}
async function startKieJob(job) {
  await setJobStatus(job, { status: 'uploading', progress: 18, message: 'Uploading your image reference to the generation service…' });
  const imageUrl = await uploadToKie(job.imagePath, 'images');
  await setJobStatus(job, { progress: 34, message: 'Uploading your motion reference to the generation service…' });
  const videoUrl = await uploadToKie(job.videoPath, 'videos');
  const callbackUrl = PUBLIC_BASE_URL && CALLBACK_SECRET ? `${PUBLIC_BASE_URL}/api/kie/callback?secret=${encodeURIComponent(CALLBACK_SECRET)}` : undefined;
  const input = { prompt: job.prompt, input_urls: [imageUrl], video_urls: [videoUrl], mode: job.quality, character_orientation: 'video', background_source: job.background };
  const payload = await requestKie(`${KIE_API_ROOT}/api/v1/jobs/createTask`, { method: 'POST', headers: { Authorization: `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'kling-3.0/motion-control', ...(callbackUrl ? { callBackUrl: callbackUrl } : {}), input }) }, 'task creation');
  const taskId = payload?.data?.taskId; if (!taskId) throw new Error('KIE did not return a task ID.');
  await setJobStatus(job, { status: 'processing', progress: 45, message: 'Kling is generating your motion clip…', kieTaskId: String(taskId) });
}
async function refreshKieJob(job) {
  if (!KIE_API_KEY || !job.kieTaskId || !['uploading', 'processing'].includes(job.status)) return;
  const payload = await requestKie(`${KIE_API_ROOT}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(job.kieTaskId)}`, { headers: { Authorization: `Bearer ${KIE_API_KEY}` } }, 'task lookup');
  const data = payload.data || {}, raw = String(data.state || '').toLowerCase();
  let result = data.resultJson;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = {}; } }
  if (raw === 'success') await setJobStatus(job, { status: 'succeeded', progress: 100, message: 'Your motion clip is ready.', outputUrl: result?.resultUrls?.[0] || result?.resultUrl });
  else if (raw === 'fail') await setJobStatus(job, { status: 'failed', progress: 100, error: data.failMsg || 'Kling could not complete this task.' });
  else await setJobStatus(job, { status: 'processing', progress: Math.min(92, Math.max(job.progress || 45, 58)), message: 'Kling is still generating your motion clip…' });
}
async function createJob(req, res) {
  let form;
  try { form = await parseForm(req); } catch (e) { return error(res, 400, 'Could not read this upload.'); }
  try {
    const user = configuredAccounts() ? await currentUser(req) : null;
    if (configuredAccounts() && !user) return error(res, 401, 'Please sign in to create a motion clip.');
    if (form.get('rightsConfirmed') !== 'true') throw new Error('Please confirm that you have the rights to use both references.');
    const image = form.get('image'), video = form.get('video'), quality = form.get('quality') === '1080p' ? '1080p' : '720p';
    await validUpload(image, IMAGE_TYPES, 10 * 1024 * 1024, 'Image'); await validUpload(video, VIDEO_TYPES, 100 * 1024 * 1024, 'Video');
    const duration = await videoDurationSeconds(video);
    if (duration < MIN_CLIP_SECONDS || duration > MAX_CLIP_SECONDS + 0.01) throw new Error(`Your motion video must be between ${MIN_CLIP_SECONDS} and ${MAX_CLIP_SECONDS} seconds.`);
    const cost = creditsFor(quality), balance = user?.credits ?? state.account.credits; if (balance < cost) throw new Error(`You need ${cost} credits for this quality.`);
    const id = randomUUID(), job = { id, ...(user ? { userId: user._id } : {}), status: KIE_API_KEY ? 'queued' : 'demo_ready', progress: KIE_API_KEY ? 5 : 100, message: KIE_API_KEY ? 'Your generation is queued securely.' : 'Demo mode is active — no generation was sent.', demo: !KIE_API_KEY, prompt: String(form.get('prompt') || '').slice(0, 2500), quality, background: form.get('background') === 'input_video' ? 'input_video' : 'input_image', duration, createdAt: new Date().toISOString(), cost };
    job.imagePath = await saveFile(image, id, 'image'); job.videoPath = await saveFile(video, id, 'video');
    if (user) { await database.collection('users').updateOne({ _id: user._id, credits: { $gte: cost } }, { $inc: { credits: -cost } }); await database.collection('jobs').insertOne(job); } else { state.account.credits -= cost; state.jobs[id] = job; await persist(); }
    json(res, 201, publicJob(job, balance - cost));
    if (KIE_API_KEY) startKieJob(job).catch(async e => setJobStatus(job, { status: 'failed', progress: 100, error: e.message }));
  } catch (e) { return error(res, 400, e.message); }
}
async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(ROOT, requested);
  if (!target.startsWith(`${ROOT}${path.sep}`)) return error(res, 403, 'Not allowed.');
  try { const info = await stat(target); if (!info.isFile()) throw new Error(); res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); createReadStream(target).pipe(res); } catch { error(res, 404, 'Not found.'); }
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`), { pathname } = url;
  if (req.method === 'POST' && pathname === '/api/auth/signup') return signUp(req, res);
  if (req.method === 'POST' && pathname === '/api/auth/signin') return signIn(req, res);
  if (req.method === 'POST' && pathname === '/api/auth/signout') return signOut(req, res);
  if (req.method === 'GET' && pathname === '/api/auth/me') { const user = await currentUser(req); return json(res, 200, { configured: configuredAccounts(), user: user ? publicUser(user) : null }); }
  if (req.method === 'GET' && pathname === '/api/account') { const user = await currentUser(req); if (configuredAccounts() && !user) return error(res, 401, 'Please sign in.'); return json(res, 200, { credits: user?.credits ?? state.account.credits, live: Boolean(KIE_API_KEY) }); }
  if (req.method === 'GET' && pathname === '/api/credit-packs') return json(res, 200, { enabled: stripeReady(), packs: STRIPE_PACKS.filter(pack => pack.priceId).map(({ id, name, description, credits }) => ({ id, name, description, credits })) });
  if (req.method === 'POST' && pathname === '/api/stripe/checkout') return createCheckout(req, res);
  if (req.method === 'POST' && pathname === '/api/stripe/webhook') return stripeWebhook(req, res);
  if (req.method === 'POST' && pathname === '/api/jobs') return createJob(req, res);
  if (req.method === 'GET' && /^\/api\/jobs\/[\w-]+$/.test(pathname)) { const user = await currentUser(req), id = pathname.split('/').pop(); if (configuredAccounts() && !user) return error(res, 401, 'Please sign in.'); const job = user ? await database.collection('jobs').findOne({ id, userId: user._id }) : state.jobs[id]; if (!job) return error(res, 404, 'Job not found.'); try { await refreshKieJob(job); } catch (e) { await setJobStatus(job, { message: 'We could not refresh Kling just now. Retrying automatically…' }); } return json(res, 200, publicJob(job, user?.credits)); }
  if (req.method === 'POST' && pathname === '/api/kie/callback') {
    if (!safeEqual(url.searchParams.get('secret'), CALLBACK_SECRET)) return error(res, 401, 'Invalid callback.');
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const taskId = String(payload?.data?.taskId || payload?.taskId || ''); const job = database ? await database.collection('jobs').findOne({ kieTaskId: taskId }) : Object.values(state.jobs).find(item => item.kieTaskId === taskId);
    if (job) await refreshKieJob(job); return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  error(res, 405, 'Method not allowed.');
});
server.listen(PORT, HOST, () => console.log(`Motionframe is running at http://${HOST}:${PORT}`));
