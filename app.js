const state = { image: null, video: null, jobId: null, pollTimer: null };
const $ = selector => document.querySelector(selector);
const imageInput = $('#imageInput'), videoInput = $('#videoInput');
const imagePreview = $('#imagePreview'), videoPreview = $('#videoPreview');
const consent = $('#rightsConsent'), formMessage = $('#formMessage');
const generateButton = $('#generateButton'), form = $('#generationForm'), prompt = $('#prompt'), dialog = $('#creditDialog');
const authDialog = $('#authDialog'), accountButton = $('#accountButton'), authForm = $('#authForm'), authMessage = $('#authMessage');
const sizeText = size => size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const setMessage = (message, error = false) => { formMessage.textContent = message; formMessage.style.color = error ? '#b33b35' : ''; };
const setBalance = credits => { $('.credit-balance strong').textContent = credits; };
const updateForm = () => {
  const ready = state.image && state.video && consent.checked;
  generateButton.disabled = !ready;
  setMessage(ready ? 'Your references are ready. Choose quality and generate.' : !state.image || !state.video ? 'Add both references to continue.' : 'Confirm that you have the rights to use both references.');
};
function clearFile(type) {
  state[type] = null;
  const input = type === 'image' ? imageInput : videoInput, preview = type === 'image' ? imagePreview : videoPreview;
  input.value = ''; preview.hidden = true; preview.style.display = '';
  if (type === 'image') preview.querySelector('img').src = '';
  updateForm();
}
function showFile(type, file) {
  state[type] = file;
  const preview = type === 'image' ? imagePreview : videoPreview;
  preview.querySelector('strong').textContent = file.name;
  preview.querySelector('span').textContent = sizeText(file.size);
  if (type === 'image') preview.querySelector('img').src = URL.createObjectURL(file);
  preview.hidden = false; preview.style.display = 'flex'; updateForm();
}
function openAuthDialog(message = 'Create an account or sign in to continue.') { authMessage.textContent = message; authDialog.showModal(); }
async function authRequest(path) { const response = await fetch(path); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not complete that request.'); return data; }
async function refreshAuth() { const data = await authRequest('/api/auth/me'); if (!data.configured) return data; if (data.user) { accountButton.innerHTML = `${data.user.email.split('@')[0]} <span>↗</span>`; setBalance(data.user.credits); } else { accountButton.innerHTML = 'Sign in <span>↗</span>'; setBalance('—'); } return data; }
function validate(type, file) {
  if (!file) return false;
  const validImage = ['image/jpeg', 'image/png'].includes(file.type) || /\.(jpe?g|png)$/i.test(file.name);
  const validVideo = ['video/mp4', 'video/quicktime'].includes(file.type) || /\.(mp4|mov)$/i.test(file.name);
  const max = type === 'image' ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
  if (!(type === 'image' ? validImage : validVideo)) { setMessage(`Please add a valid ${type === 'image' ? 'JPG or PNG image' : 'MP4 or MOV video'}.`, true); return false; }
  if (file.size > max) { setMessage(`This ${type} is too large. The limit is ${type === 'image' ? '10 MB' : '100 MB'}.`, true); return false; }
  return true;
}
function handleFile(type, file) {
  if (!validate(type, file)) return;
  if (type !== 'video') return showFile(type, file);
  const probe = document.createElement('video'); probe.preload = 'metadata';
  probe.onloadedmetadata = () => { URL.revokeObjectURL(probe.src); if (probe.duration < 3 || probe.duration > 30) return setMessage('Your motion video must be between 3 and 30 seconds.', true); showFile(type, file); };
  probe.onerror = () => setMessage('We could not read that video. Please choose an MP4 or MOV file.', true);
  probe.src = URL.createObjectURL(file);
}
[['image', imageInput, $('#imageDropZone')], ['video', videoInput, $('#videoDropZone')]].forEach(([type, input, zone]) => {
  input.addEventListener('change', () => handleFile(type, input.files[0]));
  ['dragenter', 'dragover'].forEach(event => zone.addEventListener(event, e => { e.preventDefault(); zone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(event => zone.addEventListener(event, e => { e.preventDefault(); zone.classList.remove('dragging'); }));
  zone.addEventListener('drop', e => handleFile(type, e.dataTransfer.files[0]));
});
imagePreview.querySelector('button').addEventListener('click', () => clearFile('image'));
videoPreview.querySelector('button').addEventListener('click', () => clearFile('video'));
prompt.addEventListener('input', () => $('#characterCount').textContent = prompt.value.length);
consent.addEventListener('change', updateForm);
async function openCreditDialog() {
  dialog.showModal();
  const body = $('#creditDialogBody'); body.innerHTML = '<p class="section-label">Credit packs</p><h2>Loading available packs…</h2><p>Secure checkout is provided by Stripe.</p>';
  try {
    const response = await fetch('/api/credit-packs'), data = await response.json();
    if (!data.enabled) { body.innerHTML = '<p class="section-label">Not live yet</p><h2>Credit packs are being configured.</h2><p>Checkout will appear here once Stripe is connected.</p>'; return; }
    body.innerHTML = `<p class="section-label">Credit packs</p><h2>Choose your next render budget.</h2><div class="credit-packs">${data.packs.map(pack => `<button type="button" data-pack="${pack.id}"><strong>${pack.name}</strong><span>${pack.credits} credits <b>→</b></span></button>`).join('')}</div><p>Payments are processed securely by Stripe.</p>`;
    body.querySelectorAll('[data-pack]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true; button.textContent = 'Opening secure checkout…';
      try { const checkout = await fetch('/api/stripe/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pack: button.dataset.pack }) }); const data = await checkout.json(); if (!checkout.ok) throw new Error(data.error); window.location.assign(data.url); } catch (error) { button.disabled = false; button.textContent = error.message; }
    }));
  } catch { body.innerHTML = '<p class="section-label">Not live yet</p><h2>Credit packs are being configured.</h2><p>Start the Motionframe server to configure checkout.</p>'; }
}
document.querySelectorAll('#buyCredits, #pricingButton').forEach(button => button.addEventListener('click', openCreditDialog));
$('.dialog-close').addEventListener('click', () => dialog.close()); $('.dialog-button').addEventListener('click', () => dialog.close());
function showResult(job) {
  $('#resultCard').hidden = false;
  const demo = job.status === 'demo_ready', completed = job.status === 'succeeded' || demo, failed = ['failed', 'canceled'].includes(job.status);
  $('#resultEyebrow').textContent = completed ? 'Generation complete' : failed ? 'Generation failed' : 'Generation in progress';
  $('#resultTitle').textContent = demo ? 'Your demo job was saved' : completed ? 'Your motion clip is ready' : failed ? 'This generation could not be completed' : 'Your clip is being created';
  $('#progressText').textContent = demo ? job.message : completed ? 'Your generated video is ready to open.' : failed ? (job.error || 'Please review the job and try again.') : (job.message || 'Kling is processing your references…');
  const progress = completed ? 100 : failed ? 100 : Math.max(job.progress || 12, 12);
  $('#progressNumber').textContent = `${progress}%`; $('#progressBar').style.width = `${progress}%`;
  $('#resultHint').textContent = job.demo ? 'Demo mode is active. Add your KIE API key to create a real video.' : completed ? 'The link opens the result provided by the generation service.' : 'You can keep this page open while we check the job status.';
  $('.spinner').style.display = completed || failed ? 'none' : '';
  const link = $('#downloadResult'); link.hidden = !job.outputUrl; if (job.outputUrl) link.href = job.outputUrl;
}
async function refreshBalance() { const response = await fetch('/api/account'); if (response.status === 401) return null; if (!response.ok) throw new Error('Could not connect to Motionframe right now.'); const account = await response.json(); setBalance(account.credits); return account; }
async function pollJob() {
  if (!state.jobId) return;
  try { const response = await fetch(`/api/jobs/${state.jobId}`); const job = await response.json(); if (!response.ok) throw new Error(job.error || 'Could not check the generation status.'); showResult(job); setBalance(job.credits); if (['succeeded', 'failed', 'canceled', 'demo_ready'].includes(job.status)) clearInterval(state.pollTimer); } catch (error) { $('#progressText').textContent = error.message; }
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (!state.image || !state.video || !consent.checked) return updateForm();
  generateButton.disabled = true; setMessage('Uploading references securely…');
  const body = new FormData();
  body.append('image', state.image); body.append('video', state.video); body.append('prompt', prompt.value); body.append('background', $('#background').value); body.append('quality', $('#quality').value); body.append('rightsConfirmed', 'true');
  try { const response = await fetch('/api/jobs', { method: 'POST', body }); const job = await response.json(); if (response.status === 401) { openAuthDialog(job.error); throw new Error('Sign in to create your clip.'); } if (!response.ok) throw new Error(job.error || 'Could not start your generation.'); state.jobId = job.id; setBalance(job.credits); showResult(job); $('#resultCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); clearInterval(state.pollTimer); state.pollTimer = setInterval(pollJob, 5000); } catch (error) { setMessage(error.message, true); generateButton.disabled = false; }
});
accountButton.addEventListener('click', () => openAuthDialog());
authForm.addEventListener('submit', async event => { event.preventDefault(); const email = $('#authEmail').value, password = $('#authPassword').value; try { const response = await fetch('/api/auth/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); authDialog.close(); await refreshAuth(); await refreshBalance(); } catch (error) { authMessage.textContent = error.message; } });
$('#signUpButton').addEventListener('click', async () => { const email = $('#authEmail').value, password = $('#authPassword').value; try { const response = await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); authDialog.close(); await refreshAuth(); await refreshBalance(); } catch (error) { authMessage.textContent = error.message; } });
authDialog.querySelector('.dialog-close').addEventListener('click', () => authDialog.close());
refreshAuth().then(refreshBalance).catch(error => setMessage(error.message, true));
