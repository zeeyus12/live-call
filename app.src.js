import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

  const SUPABASE_URL = 'https://ewgtpxomgkpbmfyddypw.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_NkeueZ7vabkD9nUIPDaGwQ_GCd5Ci40';
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  // Note: this is Supabase's publishable/anon key, which is designed to be safely embedded in
  // client-side code — access is controlled by the Row Level Security policies on each table
  // (see supabase_schema.sql), not by hiding this key. The session token itself is the only
  // thing Supabase's own SDK keeps in localStorage — everything else below reads/writes Supabase.

  const $ = (id) => document.getElementById(id);

  // ---------- desktop / OBS detection ----------
  // isElectronShell(): actually running inside the desktop app (see /desktop) -
  // window.electronAPI only exists there, exposed by its preload script.
  // isDesktopBrowser(): a plain desktop browser, not the shell and not mobile -
  // used only to show a "there's a desktop app" hint, since OBS features
  // need the actual shell (a webpage alone can't run a local server for OBS
  // to connect to).
  function isElectronShell(){ return !!(window.electronAPI && window.electronAPI.isDesktopApp); }
  function isDesktopBrowser(){
    if (isElectronShell()) return false;
    const ua = navigator.userAgent || '';
    return !/Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  }

  function initDesktopHint(){
    const el = $('desktopHint');
    if (!el) return;
    if (isElectronShell() && !window.electronAPI.obsCaptureAvailable) {
      // Real desktop shell, but OBS output isn't available on this platform
      // yet (currently Windows-only - see /desktop/README.md for why macOS
      // needs a different, signed approach).
      $('desktopHintText').textContent = 'Desktop app — OBS output isn\u2019t available on this platform yet.';
      el.style.display = 'flex';
    } else if (isDesktopBrowser() && !localStorage.getItem('lc_desktop_hint_dismissed')) {
      $('desktopHintText').textContent = 'On a desktop? A desktop app with OBS support is in this project\u2019s /desktop folder.';
      el.style.display = 'flex';
    }
    $('desktopHintClose')?.addEventListener('click', () => {
      el.style.display = 'none';
      localStorage.setItem('lc_desktop_hint_dismissed', '1');
    });
  }
  initDesktopHint();

  // ---------- OBS virtual-camera bridge (desktop shell, Windows only for now) ----------
  // Grabs frames off a <video> element onto an offscreen canvas and hands
  // the raw RGBA pixels to window.electronAPI.sendFrameToObs(), which the
  // desktop shell's main process writes into a UnityCaptureFilter virtual
  // camera device (see /desktop/unity-capture-sender.js) for OBS to pick up
  // as a normal Video Capture Device source.
  function createObsBridge(videoEl){
    let rafId = null, canvas = null, ctx = null;
    function tick(){
      if (!videoEl.videoWidth) { rafId = requestAnimationFrame(tick); return; }
      if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
      if (canvas.width !== videoEl.videoWidth || canvas.height !== videoEl.videoHeight) {
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
      }
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      window.electronAPI.sendFrameToObs(canvas.width, canvas.height, frame.data.buffer);
      rafId = requestAnimationFrame(tick);
    }
    return {
      start(){ if (!rafId) tick(); },
      stop(){ if (rafId) { cancelAnimationFrame(rafId); rafId = null; } },
    };
  }

  function wireObsButton(btnId, videoEl){
    const btn = $(btnId);
    if (!btn) return;
    if (!isElectronShell() || !window.electronAPI.obsCaptureAvailable) return; // stays hidden (display:none from markup)
    btn.style.display = 'inline-block';
    const bridge = createObsBridge(videoEl);
    let on = false;
    btn.addEventListener('click', () => {
      on = !on;
      btn.classList.toggle('active', on);
      btn.textContent = on ? 'Sending to OBS' : 'Send to OBS';
      if (on) bridge.start(); else bridge.stop();
    });
  }
  // Wired once at boot - the video elements exist in the DOM from page load
  // (they're just display:none / not srcObject-populated until a call starts),
  // so this doesn't need to wait for a call to actually be active.
  wireObsButton('callObsBtn', $('remoteVideo'));
  wireObsButton('lfObsBtn', $('lfRemoteVideo'));

  // ---------- splash ----------
  // Always shown (unconditional - no "only for returning sessions" check here,
  // unlike Personal Studio's splash), for at least MIN_SPLASH_MS, and hidden
  // only once auth has also resolved - whichever of the two finishes last.
  const MIN_SPLASH_MS = 2300;
  let splashMinDone = false;
  let splashAuthDone = false;
  function maybeHideSplash(){
    if (!splashMinDone || !splashAuthDone) return;
    const el = $('liveSplash');
    if (!el) return;
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 450);
  }
  setTimeout(() => { splashMinDone = true; maybeHideSplash(); }, MIN_SPLASH_MS);

  // Splash background is embedded directly in styles.css (base64) - nothing
  // to fetch or cache here. Only the min-duration/fade-out timing lives here.

  // Reusable "•••" action menu - a small dismissible popover anchored near the button
  // that opened it. Used for Recent chat's overflow menu and Avatar/Voice delete,
  // instead of a bare trash-can icon sitting exposed in the row.
  let openMenuEl = null;
  function closeActionMenu(){
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
    document.removeEventListener('click', closeActionMenu, true);
  }
  function openActionMenu(anchorBtn, items){
    closeActionMenu();
    const rect = anchorBtn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'actionMenu';
    menu.innerHTML = items.map((it, i) => `<button data-i="${i}"${it.danger ? ' class="danger"' : ''}>${it.label}</button>`).join('');
    document.body.appendChild(menu);
    const menuW = menu.offsetWidth || 180;
    let left = rect.right - menuW;
    if (left < 8) left = 8;
    menu.style.left = left + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
    items.forEach((it, i) => {
      menu.querySelector(`[data-i="${i}"]`).addEventListener('click', (e) => {
        e.stopPropagation();
        closeActionMenu();
        it.onClick();
      });
    });
    openMenuEl = menu;
    setTimeout(() => document.addEventListener('click', closeActionMenu, true), 0);
  }

  // Every provider-facing API call authenticates as the signed-in user instead of
  // trusting a client-held plaintext key (see /lib/keys.js + /api/keys.js) - this
  // is the one shared way every fetch() proves who it is.
  async function authHeader(){
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // setAppHeight() (the iOS WKWebView height-gap fix) now lives in boot.js, which
  // runs before app.js has even been fetched - see the comment there for why.

  // Temporary on-screen diagnostic in case the fix above still isn't enough -
  // remove once the gap is confirmed gone. Tap the "Live Call" logo 5x to show it.
  const saProbe = document.createElement('div');
  saProbe.style.cssText = 'position:fixed; bottom:0; height:0; padding-bottom:env(safe-area-inset-bottom); visibility:hidden;';
  document.body.appendChild(saProbe);

  let logoTapCount = 0, logoTapTimer = null;
  document.getElementById('authLogo')?.addEventListener('click', () => {
    logoTapCount++;
    clearTimeout(logoTapTimer);
    logoTapTimer = setTimeout(() => { logoTapCount = 0; }, 1500);
    if (logoTapCount >= 5) {
      logoTapCount = 0;
      const vv = window.visualViewport;
      const safeBottom = getComputedStyle(saProbe).paddingBottom;
      alert(`innerHeight: ${window.innerHeight}\nscreen.height: ${window.screen.height}\nvisualViewport.height: ${vv ? vv.height : 'n/a'}\nsafe-area-inset-bottom: ${safeBottom}\ndevicePixelRatio: ${window.devicePixelRatio}\nstandalone: ${window.navigator.standalone}`);
    }
  });

  // Admin-set login background (public read, works even signed out) - falls back to
  // the plain coffee background if nothing has been uploaded via admin.html.
  (async () => {
    try {
      const { data } = await supabase.from('app_settings').select('login_bg_url').eq('id', true).maybeSingle();
      if (data?.login_bg_url) {
        const el = document.getElementById('authScreen');
        el.style.backgroundImage = `linear-gradient(rgba(30,19,13,0.32), rgba(30,19,13,0.55)), url('${data.login_bg_url}')`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        // Same background on the "install to Home Screen" gate - a person bounced
        // to that screen (opened in a browser tab, not installed) shouldn't see a
        // flat coffee card when everyone past that gate sees the real login art.
        const gate = document.getElementById('installGate');
        gate.style.backgroundImage = `linear-gradient(rgba(30,19,13,0.45), rgba(30,19,13,0.72)), url('${data.login_bg_url}')`;
        gate.style.backgroundSize = 'cover';
        gate.style.backgroundPosition = 'center';
      }
    } catch (e) {}
  })();


  const screens = { home: $('screenHome'), chat: $('screenChat'), recent: $('screenRecent'), contacts: $('screenContacts'), profile: $('screenProfile'), features: $('screenFeatures') };
  const tabBtns = document.querySelectorAll('.tabBtn');
  let gliderLeft = null;
  function moveTabGlider(name){
    const glider = $('tabGlider');
    const btn = document.querySelector(`#tabBar .tabBtn[data-tab="${name}"]`);
    if (!glider || !btn) return;
    const barRect = $('tabBar').getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    if (btnRect.width === 0) return; // tab bar hidden (desktop mode) - nothing to move
    const left = btnRect.left - barRect.left - 1, w = btnRect.width;
    if (gliderLeft === null || left === gliderLeft) {
      glider.style.transition = 'none';
      glider.style.left = left + 'px'; glider.style.width = w + 'px';
      void glider.offsetWidth;
      glider.style.transition = '';
      gliderLeft = left;
      return;
    }
    // liquid: stretch across both tabs first, then the tail catches up and settles
    const from = gliderLeft;
    glider.style.left = Math.min(from, left) + 'px';
    glider.style.width = (Math.abs(left - from) + w) + 'px';
    glider.classList.remove('moving'); void glider.offsetWidth; glider.classList.add('moving');
    clearTimeout(glider._t);
    glider._t = setTimeout(() => {
      glider.style.left = left + 'px'; glider.style.width = w + 'px';
    }, 150);
    gliderLeft = left;
  }
  function showTab(name){
    const nextEl = screens[name];
    Object.entries(screens).forEach(([k, el]) => {
      if (k === name) return;
      el.classList.remove('active');
    });
    if (nextEl) {
      nextEl.classList.add('fadeIn');
      nextEl.classList.add('active');
      requestAnimationFrame(() => nextEl.classList.remove('fadeIn'));
    }
    const navName = name === 'contacts' ? 'profile' : name; // Contacts lives under Profile now
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === navName));
    moveTabGlider(navName);
    $('homeInputBar').classList.toggle('visible', name === 'chat');
    if (name === 'chat') renderChatThread();
    if (name === 'recent') renderRecent();
    if (name === 'contacts') renderContactsTab();
    if (name === 'profile') { renderProfile(); fetchConnectedStatus(); }
    if (name === 'features') updateLfKeyHint();
    if (name === 'home') refreshHome();
  }
  tabBtns.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  window.addEventListener('resize', () => { gliderLeft = null; moveTabGlider(document.querySelector('#tabBar .tabBtn.active')?.dataset.tab || 'home'); });
  $('profileOpenContacts')?.addEventListener('click', () => showTab('contacts'));
  $('closeContactsBtn')?.addEventListener('click', () => showTab('profile'));
  setTimeout(() => moveTabGlider('home'), 50);

  $('openApiKeys')?.addEventListener('click', () => $('apiKeysScreen').classList.add('active'));
  $('closeApiKeys')?.addEventListener('click', () => $('apiKeysScreen').classList.remove('active'));

  $('openChangePassword')?.addEventListener('click', () => $('changePasswordScreen').classList.add('active'));
  $('closeChangePassword')?.addEventListener('click', () => $('changePasswordScreen').classList.remove('active'));
  $('changePasswordBtn')?.addEventListener('click', async () => {
    const p1 = $('newPassword1').value;
    const p2 = $('newPassword2').value;
    if (!p1 || p1.length < 6) { $('changePasswordHint').textContent = 'Password must be at least 6 characters.'; return; }
    if (p1 !== p2) { $('changePasswordHint').textContent = 'Passwords do not match.'; return; }
    $('changePasswordHint').textContent = 'Saving…';
    const { error } = await supabase.auth.updateUser({ password: p1 });
    if (error) { $('changePasswordHint').textContent = error.message; return; }
    $('newPassword1').value = ''; $('newPassword2').value = '';
    $('changePasswordHint').textContent = 'Password updated.';
  });


  const infoContent = {
    faq: {
      title: 'FAQ',
      html: `
        <h3>Which provider powers the calls?</h3>
        <p>Anam. Add your own Anam API key under the API screen — your calls are billed to your own account, never anyone else's.</p>
        <h3>Where do I manage my avatar or voice?</h3>
        <p>In Profile, under Avatar — it shows the avatars and voices available on your Anam account.</p>
        <h3>Is my API key visible to anyone else?</h3>
        <p>No. It's stored against your account only and sent only when you start a call.</p>
      `,
    },
    about: {
      title: 'About',
      html: `
        <h3>Live Call</h3>
        <p>A lightweight way to start a real-time video call with an AI avatar, powered by your own Anam account.</p>
        <h3>Built for iPhone</h3>
        <p>Live Call is a Progressive Web App — add it to your home screen for the full experience.</p>
      `,
    },
    policy: {
      title: 'Privacy Policy',
      html: `
        <p>This policy explains what Live Call collects, why, and how it's protected.</p>
        <h3>Account data</h3>
        <p>When you sign in (Google or email), we store your email address and a unique account ID from Supabase Auth. That's the only identity data we keep.</p>
        <h3>Your API keys</h3>
        <p>If you add your own Anam API key, it's stored encrypted in Supabase Vault, never in plaintext, and used solely to place your own calls through your own account. The app's UI never displays a saved key back to you or anyone else — you can only overwrite it with a new one.</p>
        <h3>Call content</h3>
        <p>Your persona briefs, chat messages, and call history are stored against your account so you can resume past chats. This data is not shared with other users. Live video/audio during a call is streamed directly between your device and Anam — we don't record or store the call media itself.</p>
        <h3>What we don't do</h3>
        <p>We don't sell your data, share it with advertisers, or share your API keys or call data with any other user of this app. We don't use your data to train any AI model.</p>
        <h3>Third parties involved</h3>
        <p>Supabase (auth and database), Anam (avatar/voice calls), and Groq (for the pre-call chat) process data as needed to run the app — each under their own privacy terms.</p>
        <h3>Your control</h3>
        <p>You can delete your saved API keys at any time by saving an empty value, or contact the app owner to request full account deletion.</p>
        <h3>Changes</h3>
        <p>If this policy changes materially, it'll be reflected here with an updated date. Last updated: this build.</p>
      `,
    },
    terms: {
      title: 'Terms & Conditions',
      html: `
        <p>By using Live Call, you agree to the following.</p>
        <h3>Your account and keys</h3>
        <p>You're responsible for any API keys you add and all usage or cost they incur on Anam or any other connected provider. This app does not provide free access to those services — you must have and pay for your own account with them.</p>
        <h3>Acceptable use</h3>
        <p>You may not use this app to impersonate a real, identifiable person without their explicit consent, to harass or deceive anyone, to generate content involving minors in any sexual or exploitative context, or for any illegal purpose. Creating a fictional persona or roleplaying a scenario you've written yourself is fine; impersonating a specific real person to deceive someone else is not.</p>
        <h3>No guarantee of availability</h3>
        <p>This app depends on third-party providers (Anam, Groq, Supabase). We don't control their uptime, pricing, or policy changes, and can't guarantee the app will always work exactly as described.</p>
        <h3>Approval gate</h3>
        <p>New accounts require manual approval before use. Approval can be revoked at any time at the app owner's discretion, for any reason, including suspected abuse of the acceptable use terms above.</p>
        <h3>Liability</h3>
        <p>This app is provided as-is, without warranty. The app owner isn't liable for costs incurred on your connected provider accounts, for content generated during calls, or for any consequence of how you choose to use the persona/roleplay features.</p>
        <h3>Changes</h3>
        <p>These terms may be updated as the app evolves. Continued use after a change means you accept the update.</p>
      `,
    },
  };
  document.querySelectorAll('.navRow[data-info]').forEach(row => {
    row.addEventListener('click', () => {
      const info = infoContent[row.dataset.info];
      $('infoScreenTitle').textContent = info.title;
      $('infoScreenBody').innerHTML = info.html;
      $('infoScreen').classList.add('active');
    });
  });
  $('closeInfo')?.addEventListener('click', () => $('infoScreen').classList.remove('active'));

  const state = {
    testAvatar: (() => { try { localStorage.removeItem('lc_test_avatar'); } catch(e){} return false; })(),
    systemPrompt: '',
    anamAvatarId: '',
    anamAvatarName: '',
    anamVoiceId: '',
    anamVoiceName: '',
    displayName: '',
    country: '',
    language: 'en',
    theme: 'coffee-emerald',
    avatarUrl: '',
    chatBgUrl: '',
    // Booleans only, never the plaintext - the real keys live encrypted in Supabase
    // Vault and never leave the server after the moment they're first saved (see
    // /api/keys.js, /lib/keys.js). Populated by loadKeyStatus() below.
    anamKeySet: false,
    anamKeyLocked: false,
    falKeySet: false,
    decartKeySet: false,
  };
  let currentUser = null;
  let currentChatId = null;
  let chatMessages = []; // [{role: 'user'|'assistant', content: '...'}]

  async function persist(){
    if (!currentUser) return;
    const { error } = await supabase.from('video_call_settings').upsert({
      user_id: currentUser.id,
      system_prompt: state.systemPrompt,
      anam_avatar_id: state.anamAvatarId,
      anam_avatar_name: state.anamAvatarName,
      anam_voice_id: state.anamVoiceId,
      anam_voice_name: state.anamVoiceName,
      display_name: state.displayName,
      country: state.country,
      language: state.language,
      theme: state.theme,
      avatar_url: state.avatarUrl,
      chat_bg_url: state.chatBgUrl,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error('persist() failed:', error);
      $('homeHint').textContent = 'Save failed: ' + error.message;
    }
    return !error;
  }

  async function loadKeyStatus(){
    try {
      const r = await fetch('/api/keys', { headers: await authHeader() });
      const data = await r.json();
      if (!r.ok) return;
      state.anamKeySet = !!data.anam;
      state.falKeySet = !!data.fal;
      state.decartKeySet = !!data.decart;
      state.anamKeyLocked = !!data.anamKeyLocked;
    } catch (e) { /* leave as false - UI just shows "paste your key" */ }
    if (state.anamKeyLocked) {
      $('anamApiKey').placeholder = 'Locked by admin — contact support to change this';
      $('anamApiKey').disabled = true;
      $('saveAnamKey').disabled = true;
    } else {
      $('anamApiKey').placeholder = state.anamKeySet ? 'Key saved — enter a new one to replace' : 'Paste your Anam API key';
      $('anamApiKey').disabled = false;
      $('saveAnamKey').disabled = false;
    }
    $('falApiKey').placeholder = state.falKeySet ? 'Key saved — enter a new one to replace' : 'Paste your Fal API key';
    $('decartApiKey').placeholder = state.decartKeySet ? 'Key saved — enter a new one to replace' : 'Paste your Decart API key';
    const lps = $('lucyProviderSelect'); if (lps) lps.value = lucyProvider();
  }

  async function loadSettings(){
    const { data } = await supabase.from('video_call_settings').select('*').eq('user_id', currentUser.id).maybeSingle();
    if (data) {
      state.systemPrompt = data.system_prompt || '';
      state.anamAvatarId = data.anam_avatar_id || '';
      state.anamAvatarName = data.anam_avatar_name || '';
      state.anamVoiceId = data.anam_voice_id || '';
      state.anamVoiceName = data.anam_voice_name || '';
      state.displayName = data.display_name || '';
      state.country = data.country || '';
      state.language = data.language || 'en';
      state.theme = data.theme || 'coffee-emerald';
      state.avatarUrl = data.avatar_url || '';
      state.chatBgUrl = data.chat_bg_url || '';
      applyTheme();
    } else {
      await persist(); // first login — create the row
    }
    $('anamApiKey').value = '';
    $('falApiKey').value = '';
    $('profileName').value = state.displayName;
    $('profileCountry').value = state.country;
    $('profileLanguage').value = state.language;
    $('profileTheme').value = state.theme;
    await loadKeyStatus();
    updateAnamAvatarSummary();
    await loadAdminDefaultChatBg();
    applyChatBg();
    loadChatBgOptions();
    ensureNotificationsEnabled();
    checkForNewAnnouncements();
    renderProfile();
  }

  // ---------------------------------------------------------------- Chat background
  // Three states for state.chatBgUrl: '' (no preference yet - inherits the admin's
  // default), '__none__' (user explicitly turned it off), or a specific gallery URL.
  let adminDefaultChatBg = '';
  async function loadAdminDefaultChatBg(){
    try {
      const { data } = await supabase.from('app_settings').select('chat_bg_url').eq('id', true).maybeSingle();
      adminDefaultChatBg = data?.chat_bg_url || '';
    } catch (e) { adminDefaultChatBg = ''; }
  }
  function applyChatBg(){
    const effectiveUrl = state.chatBgUrl === '__none__' ? '' : (state.chatBgUrl || adminDefaultChatBg);
    ['screenChat', 'screenFeatures'].forEach(id => {
      const el = $(id);
      if (!el) return;
      if (effectiveUrl) {
        el.style.backgroundImage = `linear-gradient(rgba(30,19,13,0.5), rgba(30,19,13,0.7)), url('${effectiveUrl}')`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
      } else {
        el.style.backgroundImage = '';
      }
    });
  }

  async function loadChatBgOptions(){
    const { data } = await supabase.from('chat_backgrounds').select('id,url').order('created_at', { ascending: false });
    const row = $('chatBgPickerRow');
    const defaultSelected = !state.chatBgUrl;
    const noneSelected = state.chatBgUrl === '__none__';
    const optionsHtml = (data || []).map(bg => `
      <button class="chatBgThumb ${state.chatBgUrl === bg.url ? 'selected' : ''}" data-url="${bg.url}"><img src="${bg.url}" /></button>
    `).join('');
    row.innerHTML = `<button class="chatBgThumb noneOption ${defaultSelected ? 'selected' : ''}" data-url="">Default</button>`
      + `<button class="chatBgThumb noneOption ${noneSelected ? 'selected' : ''}" data-url="__none__">None</button>`
      + optionsHtml;
    row.querySelectorAll('.chatBgThumb').forEach(btn => {
      btn.addEventListener('click', async () => {
        state.chatBgUrl = btn.dataset.url;
        row.querySelectorAll('.chatBgThumb').forEach(b => b.classList.toggle('selected', b === btn));
        applyChatBg();
        await persist();
      });
    });
  }

  $('profileName')?.addEventListener('blur', async () => {
    state.displayName = $('profileName').value.trim();
    await persist();
    renderProfile();
  });
  $('profileCountry')?.addEventListener('change', async () => {
    state.country = $('profileCountry').value;
    await persist();
  });
  $('profileLanguage')?.addEventListener('change', async () => {
    state.language = $('profileLanguage').value;
    await persist();
  });
  function applyTheme(){
    document.documentElement.setAttribute('data-theme', state.theme === 'coffee-emerald' ? '' : state.theme);
  }
  $('profileTheme')?.addEventListener('change', async () => {
    state.theme = $('profileTheme').value;
    applyTheme();
    await persist();
  });

  $('notifBellBtn')?.addEventListener('click', () => { $('notificationsScreen').classList.add('active'); loadAnnouncements(); });
  $('closeNotifications')?.addEventListener('click', () => $('notificationsScreen').classList.remove('active'));

  async function loadAnnouncements(){
    const { data } = await supabase.from('announcements').select('*').order('created_at', { ascending: false }).limit(30);
    const list = $('notificationsList');
    if (!data || !data.length) { list.innerHTML = '<div class="emptyState">No announcements yet.</div>'; return; }
    list.innerHTML = data.map(a => `
      <div class="profileCard" style="align-items:flex-start;">
        <div class="cBody">
          <div class="cLabel" style="color:#fff; font-weight:700; margin-bottom:4px;">${a.title.replace(/</g,'&lt;')}</div>
          <div style="font-size:13.5px; color:var(--dim); line-height:1.4;">${a.body.replace(/</g,'&lt;')}</div>
          <div style="font-size:11px; color:var(--dim); margin-top:6px;">${new Date(a.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</div>
        </div>
      </div>
    `).join('');
    const last = data[0]?.created_at;
    if (last && last !== localStorage.getItem('lastSeenAnnouncement')) {
      $('notifDot').style.display = 'block';
    }
    localStorage.setItem('lastSeenAnnouncement', last);
    $('notifDot').style.display = 'none';
  }
  async function checkForNewAnnouncements(){
    const { data } = await supabase.from('announcements').select('created_at').order('created_at', { ascending: false }).limit(1);
    const latest = data?.[0]?.created_at;
    if (latest && latest !== localStorage.getItem('lastSeenAnnouncement')) $('notifDot').style.display = 'block';
  }

  function autoGrow(){
    const el = $('briefInput');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }
  $('briefInput')?.addEventListener('input', autoGrow);
  $('briefInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  $('sendBtn')?.addEventListener('click', sendChatMessage);
  async function saveProviderKey(provider, inputId, btnId, onSaved){
    const input = $(inputId);
    const val = input.value.trim();
    const statusEl = $(provider + 'KeyStatus');
    if (!val) return;
    const btn = $(btnId);
    const originalText = btn.textContent;
    btn.textContent = 'Saving…'; btn.disabled = true;
    if (statusEl) statusEl.textContent = '';
    try {
      const r = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ provider, key: val }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (statusEl) statusEl.textContent = '✗ Save failed: ' + (data.error?.message || JSON.stringify(data.error));
        return;
      }
      state[provider + 'KeySet'] = true;
      input.value = '';
      input.placeholder = 'Key saved — enter a new one to replace';
      if (statusEl) statusEl.textContent = '✓ Saved';
      if (onSaved) onSaved();
    } catch (e) {
      if (statusEl) statusEl.textContent = '✗ Save failed: ' + (e.message || e);
    } finally {
      btn.textContent = originalText; btn.disabled = false;
    }
  }
  $('saveAnamKey')?.addEventListener('click', () => saveProviderKey('anam', 'anamApiKey', 'saveAnamKey', async () => {
    state.anamAvatarId = ''; state.anamAvatarName = '';
    state.anamVoiceId = ''; state.anamVoiceName = '';
    await persist();
    updateAnamAvatarSummary();
    loadAnamAvatars(); loadAnamVoices();
  }));
  $('saveFalKey')?.addEventListener('click', () => saveProviderKey('fal', 'falApiKey', 'saveFalKey', () => updateLfKeyHint()));
  $('saveDecartKey')?.addEventListener('click', () => saveProviderKey('decart', 'decartApiKey', 'saveDecartKey', () => updateLfKeyHint()));
  $('lucyProviderSelect')?.addEventListener('change', (e) => { try { localStorage.setItem('lucyProvider', e.target.value); } catch(_){} updateLfKeyHint(); });
  $('saveGreenapiKey')?.addEventListener('click', () => saveProviderKey('greenapi', 'greenapiApiKey', 'saveGreenapiKey'));
  document.querySelectorAll('.eyeToggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.revealFor);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  function renderChatThread(){
    const el = $('chatThread');
    el.innerHTML = chatMessages.map(m => `
      <div class="msgRow ${m.role === 'user' ? 'user' : 'ai'}"><div class="bubble">${m.content.replace(/</g,'&lt;')}</div></div>
    `).join('');
    el.scrollIntoView({ block: 'end' });
  }

  async function saveChat(title){
    if (!currentUser) return;
    if (currentChatId) {
      await supabase.from('video_call_chats').update({
        messages: chatMessages, provider: 'anam',
        title: title || undefined, updated_at: new Date().toISOString(),
      }).eq('id', currentChatId);
    } else {
      const { data } = await supabase.from('video_call_chats').insert({
        user_id: currentUser.id, messages: chatMessages, provider: 'anam',
        title: title || 'New chat',
      }).select('id').single();
      if (data) currentChatId = data.id;
    }
  }

  async function sendChatMessage(){
    const text = $('briefInput').value.trim();
    if (!text) return;
    $('briefInput').value = ''; autoGrow();
    chatMessages.push({ role: 'user', content: text });
    renderChatThread();

    chatMessages.push({ role: 'assistant', content: '…' });
    const thinkingIdx = chatMessages.length - 1;
    renderChatThread();

    try {
      const r = await fetch('/api/chat-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages.slice(0, -1).map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await r.json();
      chatMessages[thinkingIdx] = { role: 'assistant', content: r.ok ? data.reply : ('Error: ' + JSON.stringify(data.error)) };
      renderChatThread();

      // Fold the whole conversation so far into the persona brief the call actually uses.
      state.systemPrompt = chatMessages.filter(m => m.role === 'user').map(m => m.content).join(' ');
      persist();
      if (r.ok && data.title) saveChat(data.title);
      else saveChat();
    } catch (e) {
      chatMessages[thinkingIdx] = { role: 'assistant', content: 'Connection error — try again.' };
      renderChatThread();
    }
  }

  function startNewChat(){
    currentChatId = null;
    chatMessages = [];
    state.systemPrompt = '';
    $('briefInput').value = '';
    autoGrow();
    $('homeHint').textContent = '';
    renderChatThread();
  }
  $('newChatBtn')?.addEventListener('click', () => { startNewChat(); showTab('chat'); });


  async function loadAnamAvatars(){
    const sel = $('anamAvatarId');
    if (!state.anamKeySet) { sel.innerHTML = '<option value="">Add your Anam API key in the API screen first</option>'; return; }
    try {
      const r = await fetch('/api/anam?resource=avatars', { headers: await authHeader() });
      const data = await r.json();
      if (!r.ok) { sel.innerHTML = `<option value="">Error: ${JSON.stringify(data.error).slice(0,120)}</option>`; return; }
      const avatars = data.avatars || [];
      anamAvatarList = avatars;
      refreshHomeTiles();
      const options = avatars.map(a => `<option value="${a.id}">${a.name}</option>`);
      if (state.anamAvatarId && !avatars.some(a => a.id === state.anamAvatarId)) {
        options.unshift(`<option value="${state.anamAvatarId}">${state.anamAvatarName || state.anamAvatarId}</option>`);
      }
      if (!options.length) { sel.innerHTML = '<option value="">No avatars found</option>'; return; }
      sel.innerHTML = options.join('');
      if (state.anamAvatarId) sel.value = state.anamAvatarId;
      sel.onchange = () => {
        state.anamAvatarId = sel.value;
        state.anamAvatarName = sel.options[sel.selectedIndex]?.textContent || '';
        persist();
        updateAnamAvatarSummary();
      };
    } catch (e) { sel.innerHTML = '<option value="">Could not load avatars</option>'; }
  }

  async function loadAnamVoices(){
    const sel = $('anamVoiceId');
    if (!sel) return;
    if (!state.anamKeySet) { sel.innerHTML = '<option value="">Add your Anam API key in the API screen first</option>'; return; }
    try {
      const r = await fetch('/api/anam?resource=voices', { headers: await authHeader() });
      const data = await r.json();
      if (!r.ok) { sel.innerHTML = `<option value="">Error: ${JSON.stringify(data.error).slice(0,120)}</option>`; return; }
      const voices = data.voices || [];
      const options = voices.map(v => `<option value="${v.id}">${v.name}</option>`);
      if (state.anamVoiceId && !voices.some(v => v.id === state.anamVoiceId)) {
        options.unshift(`<option value="${state.anamVoiceId}">${state.anamVoiceName || state.anamVoiceId}</option>`);
      }
      sel.innerHTML = '<option value="">Default voice</option>' + options.join('');
      if (state.anamVoiceId) sel.value = state.anamVoiceId;
      updateVoiceCloneVisibility();
      sel.onchange = () => {
        state.anamVoiceId = sel.value;
        state.anamVoiceName = sel.options[sel.selectedIndex]?.textContent || '';
        persist();
        updateAnamAvatarSummary();
        updateVoiceCloneVisibility();
      };
    } catch (e) { sel.innerHTML = '<option value="">Could not load voices</option>'; }
  }


  // ---------------------------------------------------------------- Anam avatar subscreen
  function updateVoiceCloneVisibility(){
    const hasVoice = !!state.anamVoiceId;
    const section = $('voiceCloneSection');
    if (section) section.style.display = hasVoice ? 'none' : 'block';
    if (!hasVoice) $('voicePreviewRow').style.display = 'none'; // nothing active left to preview
  }
  function updateAnamAvatarSummary(){
    const parts = [];
    if (state.anamAvatarName) parts.push(state.anamAvatarName);
    if (state.anamVoiceName) parts.push(state.anamVoiceName);
    $('anamAvatarSummary').textContent = parts.join(' · ') || 'Not set';
    $('avatarPhotoTips').style.display = state.anamAvatarId ? 'none' : 'flex';
    refreshHomeTiles();
  }
  $('openAnamAvatarScreen')?.addEventListener('click', () => {
    $('anamAvatarScreen').classList.add('active');
    loadAnamAvatars();
    loadAnamVoices();
  });
  $('closeAnamAvatarScreen')?.addEventListener('click', () => {
    $('anamAvatarScreen').classList.remove('active');
    updateAnamAvatarSummary();
  });

  $('anamAvatarMenuBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.anamAvatarId) return;
    openActionMenu($('anamAvatarMenuBtn'), [{
      label: 'Delete this avatar',
      danger: true,
      onClick: async () => {
        if (!confirm(`Delete "${state.anamAvatarName || 'this avatar'}" from your Anam account? This can't be undone.`)) return;
        const r = await fetch(`/api/anam?type=avatar&id=${encodeURIComponent(state.anamAvatarId)}`, {
          method: 'DELETE',
          headers: await authHeader(),
        });
        const data = await r.json();
        if (!r.ok) { alert('Delete failed: ' + JSON.stringify(data.error)); return; }
        state.anamAvatarId = ''; state.anamAvatarName = '';
        await persist();
        loadAnamAvatars();
        updateAnamAvatarSummary();
      },
    }]);
  });

  $('anamVoiceMenuBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.anamVoiceId) return;
    openActionMenu($('anamVoiceMenuBtn'), [{
      label: 'Delete this voice',
      danger: true,
      onClick: async () => {
        if (!confirm(`Delete "${state.anamVoiceName || 'this voice'}" from your Anam account? This can't be undone.`)) return;
        const r = await fetch(`/api/anam?type=voice&id=${encodeURIComponent(state.anamVoiceId)}`, {
          method: 'DELETE',
          headers: await authHeader(),
        });
        const data = await r.json();
        if (!r.ok) { alert('Delete failed: ' + JSON.stringify(data.error)); return; }
        state.anamVoiceId = ''; state.anamVoiceName = '';
        await persist();
        loadAnamVoices();
        updateAnamAvatarSummary();
      },
    }]);
  });

  // ---------------------------------------------------------------- Anam custom avatar photo
  $('openAvatarUpload')?.addEventListener('click', () => $('avatarPhotoInput').click());
  $('avatarPhotoInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // allow picking the same file again later
    if (!file) return;
    const statusEl = $('avatarUploadStatus');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      statusEl.textContent = 'Use a PNG, JPEG, or WEBP photo.'; return;
    }
    if (file.size > 4.5 * 1024 * 1024) {
      statusEl.textContent = 'Photo is too large — 4.5MB max.'; return;
    }
    if (!state.anamKeySet) { statusEl.textContent = 'Add your Anam API key first.'; return; }
    try {
      statusEl.textContent = 'Uploading photo…';
      const ext = file.type.split('/')[1];
      const path = `${currentUser.id}/avatars/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('user-uploads').upload(path, file, { contentType: file.type, upsert: true });
      if (upErr) { statusEl.textContent = 'Upload failed: ' + upErr.message; return; }
      const { data: pub } = supabase.storage.from('user-uploads').getPublicUrl(path);

      statusEl.textContent = 'Creating your avatar…';
      const r = await fetch('/api/anam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ action: 'upload-avatar', imageUrl: pub.publicUrl, displayName: (state.displayName ? `${state.displayName}'s avatar` : 'My avatar') }),
      });
      const data = await r.json();
      if (!r.ok) { statusEl.textContent = 'Anam error: ' + JSON.stringify(data.error).slice(0, 140); return; }

      state.anamAvatarId = data.id;
      state.anamAvatarName = data.name;
      anamAvatarList = anamAvatarList.filter(a => a.id !== data.id).concat([{ id: data.id, name: data.name, image_url: data.imageUrl || '' }]);
      try { localStorage.setItem(avPhotoKey(), JSON.stringify({ id: data.id, url: pub.publicUrl })); } catch(_){}
      await persist();
      statusEl.textContent = 'Saved — ' + data.name;
      loadAnamAvatars();
      updateAnamAvatarSummary();
    } catch (err) {
      statusEl.textContent = 'Failed: ' + (err.message || err);
    }
  });

  // ---------------------------------------------------------------- Anam voice cloning
  let voiceRecorder = null, voiceChunks = [], voiceTimer = null, voiceSeconds = 0;
  const VOICE_MAX_SECONDS = 30;

  function setVoiceRecordUI(recording){
    $('voiceRecordBtn').textContent = recording ? 'Stop' : 'Record';
  }

  $('voiceRecordBtn')?.addEventListener('click', () => {
    if (voiceRecorder && voiceRecorder.state === 'recording') stopVoiceRecording();
    else startVoiceRecording();
  });

  async function startVoiceRecording(){
    const statusEl = $('voiceRecordStatus');
    if (!state.anamKeySet) { statusEl.textContent = 'Add your Anam API key first.'; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceChunks = [];
      voiceRecorder = new MediaRecorder(stream);
      voiceRecorder.ondataavailable = (e) => { if (e.data.size > 0) voiceChunks.push(e.data); };
      voiceRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(voiceTimer);
        setVoiceRecordUI(false);
        const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' });
        await uploadVoiceClip(blob);
      };
      voiceRecorder.start();
      voiceSeconds = 0;
      setVoiceRecordUI(true);
      statusEl.textContent = `Recording… ${voiceSeconds}s`;
      voiceTimer = setInterval(() => {
        voiceSeconds++;
        statusEl.textContent = `Recording… ${voiceSeconds}s`;
        if (voiceSeconds >= VOICE_MAX_SECONDS) stopVoiceRecording();
      }, 1000);
    } catch (e) {
      statusEl.textContent = 'Microphone permission is required.';
    }
  }

  function stopVoiceRecording(){
    if (voiceRecorder && voiceRecorder.state !== 'inactive') voiceRecorder.stop();
  }

  async function uploadVoiceClip(blob){
    const statusEl = $('voiceRecordStatus');
    statusEl.textContent = 'Uploading…';
    $('voicePreviewRow').style.display = 'none';
    try {
      // A recorded Blob has no filename (only File objects from a file input do) - derive
      // one from its mime type since Anam's presigned-upload endpoint requires both.
      const contentType = blob.type || 'audio/webm';
      const ext = (blob.name && blob.name.includes('.')) ? blob.name.split('.').pop()
        : (contentType.split('/')[1] || 'webm').split(';')[0];
      const filename = blob.name || `voice-${Date.now()}.${ext}`;

      const urlResp = await fetch('/api/anam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ action: 'voice-upload-url', filename, contentType, fileSize: blob.size }),
      });
      const urlData = await urlResp.json();
      if (!urlResp.ok) { statusEl.textContent = 'Error: ' + JSON.stringify(urlData.error).slice(0, 140); return; }

      await fetch(urlData.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob });

      const createResp = await fetch('/api/anam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ action: 'create-voice', audioKey: urlData.audioKey, displayName: (state.displayName ? `${state.displayName}'s voice` : 'My voice') }),
      });
      const createData = await createResp.json();
      if (!createResp.ok) { statusEl.textContent = 'Error: ' + JSON.stringify(createData.error).slice(0, 140); return; }

      state.anamVoiceId = createData.id;
      state.anamVoiceName = createData.name;
      await persist();
      statusEl.textContent = 'Saved — ' + createData.name;
      // Anam doesn't expose a way to synthesize a quick sample from a brand-new voice
      // outside of a live session, so this plays back the exact clip that was just
      // cloned from - the honest, reliable version of "hear how it sounds."
      const audioEl = $('voicePreviewAudio');
      audioEl.src = URL.createObjectURL(blob);
      $('voicePreviewRow').style.display = 'flex';
      loadAnamVoices();
      updateAnamAvatarSummary();
    } catch (err) {
      statusEl.textContent = 'Upload failed: ' + (err.message || err);
    }
  }

  $('voicePreviewBtn')?.addEventListener('click', () => {
    const audioEl = $('voicePreviewAudio');
    const btn = $('voicePreviewBtn');
    if (!audioEl.src) return;
    if (!audioEl.paused) { audioEl.pause(); return; }
    audioEl.play().catch(() => {});
  });
  $('voicePreviewAudio')?.addEventListener('play', () => { $('voicePreviewBtn').textContent = '❚❚'; });
  $('voicePreviewAudio')?.addEventListener('pause', () => { $('voicePreviewBtn').textContent = '▶'; });
  $('voicePreviewAudio')?.addEventListener('ended', () => { $('voicePreviewBtn').textContent = '▶'; });

  $('voiceUploadBtn')?.addEventListener('click', () => $('voiceFileInput').click());
  $('voiceFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const statusEl = $('voiceRecordStatus');
    if (!state.anamKeySet) { statusEl.textContent = 'Add your Anam API key first.'; return; }
    if (file.size > 4.5 * 1024 * 1024) { statusEl.textContent = 'Audio file is too large — 4.5MB max.'; return; }
    await uploadVoiceClip(file);
  });


  function renderProfile(){
    $('profileEmail').textContent = state.displayName || 'Add your name';
    $('profileSub').textContent = state.displayName ? (currentUser?.email || '') : 'Complete your profile below';
    if (state.avatarUrl) {
      $('profilePhotoImg').src = state.avatarUrl;
      $('profilePhotoImg').style.display = 'block';
      $('profilePhotoDefault').style.display = 'none';
    } else {
      $('profilePhotoImg').style.display = 'none';
      $('profilePhotoDefault').style.display = 'block';
    }
    updateTabBarAvatar();
    refreshHomeHeader();
  }

  $('profilePhotoBtn')?.addEventListener('click', () => $('profilePhotoInput').click());
  $('profilePhotoInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !currentUser) return;
    $('photoUploadHint').textContent = 'Uploading…';
    const path = `${currentUser.id}/profile.${file.name.split('.').pop()}`;
    const { error: upErr } = await supabase.storage.from('user-uploads').upload(path, file, { upsert: true, cacheControl: '3600' });
    if (upErr) { $('photoUploadHint').textContent = 'Upload failed: ' + upErr.message; return; }
    const { data: pub } = supabase.storage.from('user-uploads').getPublicUrl(path);
    state.avatarUrl = pub.publicUrl + '?t=' + Date.now();
    await persist();
    renderProfile();
    $('photoUploadHint').textContent = '';
  });

  function updateTabBarAvatar(){
    const img = $('tabProfileImg'), fallback = $('tabProfileDefault');
    if (!img) return;
    if (state.avatarUrl) { img.src = state.avatarUrl; img.style.display = 'block'; fallback.style.display = 'none'; }
    else { img.style.display = 'none'; fallback.style.display = 'block'; }
  }

  // ---------- push notifications ----------
  const VAPID_PUBLIC_KEY = 'BERe9PaZxK_8m5HY4fqmzJrDcjXd5jDrcgrV8GTiiWC_HXWVKXM-li-jHId_oJ9CE73EYlxTQPhlAOlG_4NdgHw';
  function urlBase64ToUint8Array(base64String){
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
  // Notifications have no manual toggle in Profile - they're important enough that we
  // just enable them ourselves the moment someone signs in, silently. If permission was
  // already denied at the OS level we can't re-prompt (browsers block that) and just
  // leave it; if it's still undecided, this triggers the native permission prompt.
  async function ensureNotificationsEnabled(){
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) return; // already enabled
      if (Notification.permission === 'denied') return; // can't re-prompt, nothing to do
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await fetch('/api/save-push-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch (e) { console.error('ensureNotificationsEnabled failed:', e); }
  }


  async function addHistory(entry){
    if (!currentUser) return null;
    const { data } = await supabase.from('video_call_history').insert({
      user_id: currentUser.id,
      provider: entry.provider,
      summary: entry.summary,
    }).select('id').single();
    return data?.id || null;
  }
  async function renderRecent(){
    const list = $('recentList');
    if (!currentUser) return;

    // Fetch both AI chats and social calls
    const [chatsRes, socialRes] = await Promise.all([
      supabase.from('video_call_chats').select('*').eq('user_id', currentUser.id).order('updated_at', { ascending: false }).limit(50),
      fetch(SOCIAL_CALL_API_BASE + '/api/social-call/history').then(r => r.json()).catch(() => ({ history: [] }))
    ]);

    const data = chatsRes.data || [];
    const socialCalls = socialRes.history || [];

    if (!data.length && !socialCalls.length) {
      list.innerHTML = '<div class="emptyState">No calls yet. Place a call or brief the AI on Home to start.</div>';
      return;
    }

    const socialRows = socialCalls.map(c => `
      <div class="callRow socialCallRow" style="cursor:default;">
        <div class="chatAvatar" style="background:${c.platform === 'whatsapp' ? '#25D366' : '#2AABEE'};">
          ${c.platform === 'whatsapp'
            ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2ZM12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.59 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67ZM8.79 7.34C8.61 7.34 8.31 7.41 8.06 7.68C7.81 7.95 7.11 8.61 7.11 9.94C7.11 11.27 8.08 12.55 8.22 12.73C8.36 12.92 10.13 15.65 12.84 16.82C13.49 17.1 13.99 17.26 14.38 17.39C15.04 17.6 15.64 17.57 16.11 17.5C16.64 17.42 17.73 16.84 17.96 16.19C18.19 15.54 18.19 14.99 18.12 14.87C18.05 14.75 17.87 14.68 17.6 14.54C17.33 14.4 16 13.75 15.75 13.66C15.5 13.57 15.32 13.52 15.14 13.79C14.96 14.07 14.44 14.68 14.28 14.87C14.13 15.05 13.97 15.07 13.7 14.94C13.43 14.8 12.56 14.52 11.53 13.6C10.73 12.89 10.19 12.01 10.03 11.74C9.87 11.46 10.01 11.31 10.15 11.18C10.27 11.06 10.42 10.86 10.56 10.7C10.7 10.54 10.75 10.42 10.84 10.24C10.93 10.06 10.89 9.9 10.82 9.76C10.75 9.62 10.2 8.27 9.97 7.73C9.75 7.2 9.53 7.28 9.36 7.27C9.21 7.26 9.01 7.26 8.81 7.26L8.79 7.34Z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>'
          }
        </div>
        <div class="rowMain">
          <div class="name">${(c.name || c.target).replace(/</g,'&lt;')}</div>
          <div class="summary" style="display:flex; align-items:center; gap:6px;">
            <span class="socialBadge ${c.platform}">${c.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}</span>
            <span>•</span>
            <span>${c.duration || '0m 0s'}</span>
          </div>
        </div>
        <div class="rowRight">
          <div class="time">${new Date(c.startedAt).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</div>
        </div>
      </div>
    `).join('');

    const chatRows = data.map(c => {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const lastMsg = msgs[msgs.length - 1]?.content || '';
      const title = c.title || 'New chat';
      const initials = title.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
      return `
      <div class="callRow" data-chat-id="${c.id}">
        <div class="chatAvatar">${initials}</div>
        <div class="rowMain" style="cursor:pointer;" data-open-chat-id="${c.id}">
          <div class="name">${title.replace(/</g,'&lt;')}</div>
          <div class="summary">${lastMsg.replace(/</g,'&lt;').slice(0, 80)}</div>
        </div>
        <div class="rowRight">
          <div class="time">${new Date(c.updated_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</div>
          <button class="kebabBtn" data-menu-chat-id="${c.id}" aria-label="Chat options">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="6" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="18" r="1.6" fill="currentColor"/></svg>
          </button>
        </div>
      </div>
    `;
    }).join('');

    list.innerHTML = socialRows + chatRows;
    list.querySelectorAll('[data-open-chat-id]').forEach(row => {
      row.addEventListener('click', () => resumeChat(row.dataset.openChatId, data));
    });
    list.querySelectorAll('[data-menu-chat-id]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const chatId = btn.dataset.menuChatId;
        openActionMenu(btn, [{
          label: 'Delete chat',
          danger: true,
          onClick: async () => {
            if (!confirm('Delete this chat?')) return;
            await supabase.from('video_call_chats').delete().eq('id', chatId);
            if (currentChatId === chatId) startNewChat();
            renderRecent();
          },
        }]);
      });
    });
  }

  function resumeChat(chatId, chats){
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return;
    currentChatId = chat.id;
    chatMessages = Array.isArray(chat.messages) ? chat.messages : [];
    state.systemPrompt = chatMessages.filter(m => m.role === 'user').map(m => m.content).join(' ');
    persist();
    showTab('chat');
    renderChatThread();
  }

  const callScreen = $('callScreen'), callIdle = $('callIdle'), callStatus = $('callStatus'), callBottom = $('callBottom');
  const remoteVideo = $('remoteVideo'), liveDot = $('liveDot');
  // Pinned (not @latest) so a CDN re-resolve can't slow or break call start, and
  // preloadable: kicked off while the phone is still ringing.
  let _anamSdkPromise = null;
  // A stand-in for the Anam client that costs nothing: an animated test card with a running clock, and a
  // beep when the app tells it the call is connected. Same few methods the app uses on the real client, so
  // the whole call flow (gating, call audio/video, summary) runs unchanged and you can see/hear on the
  // OTHER phone what the call really delivers.
  const TEST_EVENTS = { VIDEO_PLAY_STARTED: 'VIDEO_PLAY_STARTED', CONNECTION_CLOSED: 'CONNECTION_CLOSED', SERVER_WARNING: 'SERVER_WARNING', MESSAGE_HISTORY_UPDATED: 'MESSAGE_HISTORY_UPDATED' };
  function createTestAvatarClient(){
    const handlers = {}; let raf = 0, stream = null, ac = null, gain = null, t0 = 0, history = [];
    const emit = (ev, ...a) => (handlers[ev] || []).forEach((f) => { try { f(...a); } catch(e){} });
    return {
      addListener(ev, cb){ (handlers[ev] = handlers[ev] || []).push(cb); },
      getActiveSessionId(){ return 'test-avatar'; },
      async streamToVideoElement(elementId){
        const c = document.createElement('canvas'); c.width = 360; c.height = 640; const x = c.getContext('2d'); t0 = Date.now();
        const draw = () => {
          const t = (Date.now() - t0) / 1000;
          const g = x.createLinearGradient(0, 0, 360, 640); g.addColorStop(0, '#ff7a00'); g.addColorStop(1, '#7a2bff');
          x.fillStyle = g; x.fillRect(0, 0, 360, 640);
          x.fillStyle = 'rgba(255,255,255,0.9)'; x.beginPath(); x.arc(180 + Math.sin(t * 2) * 110, 320 + Math.cos(t * 1.3) * 140, 70, 0, 7); x.fill();
          x.fillStyle = '#fff'; x.font = 'bold 44px sans-serif'; x.textAlign = 'center'; x.fillText('TEST AVATAR', 180, 90);
          x.font = '28px sans-serif'; x.fillText(t.toFixed(1) + ' s', 180, 140);
          x.font = '20px sans-serif'; x.fillText('edge to edge: corners should be coloured', 180, 610);
          raf = requestAnimationFrame(draw);
        };
        draw();
        const AC = window.AudioContext || window.webkitAudioContext; ac = new AC(); const dest = ac.createMediaStreamDestination();
        const osc = ac.createOscillator(); osc.frequency.value = 440; gain = ac.createGain(); gain.gain.value = 0; osc.connect(gain).connect(dest); osc.start();
        stream = new MediaStream([...c.captureStream(15).getVideoTracks(), ...dest.stream.getAudioTracks()]);
        const el = document.getElementById(elementId); el.srcObject = stream;
        try { await el.play(); } catch(e){}
        setTimeout(() => emit(TEST_EVENTS.VIDEO_PLAY_STARTED), 300);
      },
      muteInputAudio(){}, unmuteInputAudio(){},
      sendUserMessage(){
        // "Told the call is connected": beep for one second so you can hear when the avatar would start talking.
        try { if (gain) { gain.gain.setValueAtTime(0.6, ac.currentTime); gain.gain.setValueAtTime(0, ac.currentTime + 1); } } catch(e){}
        history = [{ role: 'persona', content: '(test avatar: beep - this is where the avatar would greet you)' }];
        setTimeout(() => emit(TEST_EVENTS.MESSAGE_HISTORY_UPDATED, history), 50);
      },
      async stopStreaming(){ cancelAnimationFrame(raf); try { stream && stream.getTracks().forEach((t) => t.stop()); } catch(e){} try { ac && ac.close(); } catch(e){} stream = null; },
    };
  }
  function loadAnamSdk(){
    if (!_anamSdkPromise) {
      _anamSdkPromise = import('https://esm.sh/@anam-ai/js-sdk@4.27.1').catch((e) => { _anamSdkPromise = null; throw e; });
    }
    return _anamSdkPromise;
  }
  // Mints an Anam session token; retries once on a network error or 5xx/429.
  async function mintAnamSession(){
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch('/api/anam', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
          body: JSON.stringify({ action: 'session', avatarId: state.anamAvatarId, voiceId: state.anamVoiceId, systemPrompt: promptWithLanguage(), callerName: state.displayName, callContext: socialCallContext }),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok) return data;
        lastErr = new Error('Anam error: ' + JSON.stringify(data.error));
        if (resp.status < 500 && resp.status !== 429) throw lastErr;
      } catch (e) { lastErr = e; if (/^Anam error/.test(e.message) && attempt === 1) throw e; }
      await new Promise(r => setTimeout(r, 800));
    }
    throw lastErr;
  }
  let anamClient = null, micStream = null, audioCtx = null, callStartedAt = null, callStarting = false;

  function primeAudioSession(){
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      setTimeout(() => { try { osc.stop(); } catch(e){} }, 300);
    } catch (e) {}
  }

  async function startCall(){
    // Guards against the actual root cause of the duplicate-notification bug:
    // repeated taps on the call button (impatience during a slow connect, or a
    // double-tap) each spawned their own Anam session with its own
    // CONNECTION_CLOSED listener. When they all eventually closed, each one
    // independently fired its own /api/call-summary request and push
    // notification - which is exactly the "~50 notifications, same result
    // reworded" symptom (each session had no real transcript, so each got
    // the same generic fallback summary, just from a separate LLM call).
    if (callStarting || callScreen.classList.contains('active')) return;
    callStarting = true;
    try {
    // Prefer whatever is still typed in the box; if it's empty (e.g. already sent as a
    // chat message, which clears the box), fall back to what's actually in the chat.
    const typed = $('briefInput').value.trim();
    state.systemPrompt = typed || chatMessages.filter(m => m.role === 'user').map(m => m.content).join(' ');
    persist();
    if (!state.systemPrompt) {
      $('homeHint').textContent = 'Type what you want it to do first.';
      return;
    }
    if (!state.anamAvatarId) {
      $('homeHint').textContent = 'Pick an avatar first.';
      return;
    }
    $('homeHint').textContent = '';

    callScreen.classList.add('active');
    callIdle.style.display = 'flex';
    $('callConfirm').textContent = `Got it — I'll ${state.systemPrompt.length > 70 ? state.systemPrompt.slice(0, 70).trim() + '…' : state.systemPrompt}`;
    startConnectingMessages();
    liveDot.classList.remove('live');

    primeAudioSession();

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      stopConnectingMessages();
      callStatus.textContent = 'Microphone permission is required';
      callScreen.classList.remove('active');
      return;
    }

    callStartedAt = Date.now();
    await startAnam();
    } finally {
      callStarting = false;
    }
  }

  // Cycles a few short phrases instead of a single static "Connecting…" - the call
  // still takes a few seconds either way, but rotating text reads as progress
  // instead of a stall.
  const CONNECTING_MESSAGES = ['Connecting…', 'Setting the scene…', 'Warming up the avatar…', 'Almost there…'];
  let connectingMsgTimer = null;
  function startConnectingMessages(){
    let i = 0;
    callStatus.textContent = CONNECTING_MESSAGES[0];
    clearInterval(connectingMsgTimer);
    connectingMsgTimer = setInterval(() => {
      i = (i + 1) % CONNECTING_MESSAGES.length;
      callStatus.textContent = CONNECTING_MESSAGES[i];
    }, 2200);
  }
  function stopConnectingMessages(){
    clearInterval(connectingMsgTimer);
    connectingMsgTimer = null;
  }

  async function startAnam(){
    if (!state.anamKeySet) { callStatus.textContent = 'Add your Anam API key in Profile settings first.'; return; }
    const resp = await fetch('/api/anam', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ action: 'session', avatarId: state.anamAvatarId, voiceId: state.anamVoiceId, systemPrompt: promptWithLanguage(), callerName: state.displayName }),
    });
    const data = await resp.json();
    if (!resp.ok) { callStatus.textContent = 'Anam error: ' + JSON.stringify(data.error); return; }

    const { createClient, AnamEvent } = await loadAnamSdk();
    anamClient = createClient(data.sessionToken);

    remoteVideo.muted = false;
    remoteVideo.volume = 1.0;

    anamClient.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
      remoteVideo.style.display = 'block';
      callIdle.style.display = 'none';
      stopConnectingMessages();
      liveDot.classList.add('live');
      callBottom.classList.remove('hidden');
    });
    anamClient.addListener(AnamEvent.CONNECTION_CLOSED, () => endCall());

    // The Anam SDK owns #remoteVideo directly - it captures its own mic and
    // streams both audio and video into it.
    await anamClient.streamToVideoElement('remoteVideo');
  }

  const LANGUAGE_NAMES = { en:'English', es:'Spanish', fr:'French', pt:'Portuguese', de:'German', ha:'Hausa', yo:'Yoruba', ig:'Igbo', sw:'Swahili', ar:'Arabic', hi:'Hindi', zh:'Chinese' };
  // What the avatar needs to know about the call it is on (direction, platform, who the callee is).
  // Sent with the session request; the server folds it into the prompt (lib/anamPrompt.js).
  let socialCallContext = null;
  function setSocialCallContext(direction, platform, name){
    socialCallContext = { direction, platform, otherName: name || '' };
  }
  function promptWithLanguage(){
    if (!state.language || state.language === 'en') return state.systemPrompt;
    return `Speak only in ${LANGUAGE_NAMES[state.language] || state.language} for this entire call, regardless of what language the brief below is written in. ${state.systemPrompt}`;
  }

  function endCall(){
    // Idempotent: null callStartedAt out immediately so a second CONNECTION_CLOSED
    // (or a stray call to endCall from anywhere else) can't fire a second
    // summary/push for the same call.
    if (!callStartedAt) return;
    stopConnectingMessages();
    const durationSec = Math.round((Date.now() - callStartedAt) / 1000);
    const startedHistoryUpdate = (async () => {
      const historyId = await addHistory({
        provider: 'anam',
        time: new Date().toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
        summary: durationSec > 0 ? `Call ended after ${durationSec}s` : 'Call ended immediately',
      });
      // Fire-and-forget on purpose: the summary takes a few seconds (Anam's
      // session report + our own summarization pass), and the push
      // notification - not this request staying open - is what actually
      // reaches the user if they've already left the app.
      if (!historyId || durationSec <= 0) return;
      try {
        await fetch('/api/call-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
          body: JSON.stringify({ historyId }),
        });
      } catch (e) { console.error('call-summary request failed:', e); }
    })();
    callStartedAt = null;
    if (anamClient) { try { anamClient.stopStreaming(); } catch(e){} anamClient = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch(e){} audioCtx = null; }
    remoteVideo.srcObject = null;
    remoteVideo.style.display = 'none';
    liveDot.classList.remove('live');
    callBottom.classList.add('hidden');
    callScreen.classList.remove('active');
    callStartedAt = null;
  }

  callScreen.addEventListener('click', (e) => {
    if (e.target.closest('#callTop') || e.target.closest('#callBottom')) return;
    callBottom.classList.toggle('hidden');
    $('callTop').classList.toggle('hidden');
  });

  // ---------------------------------------------------------------- Live Filter (Fal.ai / Decart Lucy 2.5)
  // Runs the user's camera through Fal's real-time video-to-video model over
  // WebRTC. Uses the same per-user Vault key pattern as Anam (see /api/keys.js,
  // /lib/keys.js) - the plaintext Fal key never reaches this client, only a
  // short-lived realtime token minted by /api/fal-realtime-token.
  let lfReferenceImageUrl = '';
  let lfReferenceDescription = ''; // strict, non-hallucinated description of the uploaded photo - see /api/describe-reference.js

  // Mirrors every diagnostic line onto a hidden on-screen log (not shown to
  // the person by default - raw provider/model/token details shouldn't be
  // visible in a screenshot). Tap the pulse logo 5x during a call to reveal
  // it, same pattern as the "tap logo 5x" diagnostic already used at boot.
  function lfDebug(msg){
    console.log('[LiveFilter]', msg);
    const el = $('lfDebugLog');
    if (!el) return;
    const t = new Date().toISOString().slice(11, 19);
    el.textContent += `[${t}] ${msg}\n`;
  }
  let lfDebugTapCount = 0, lfDebugTapTimer = null;
  $('lfPulse')?.addEventListener('click', () => {
    lfDebugTapCount++;
    clearTimeout(lfDebugTapTimer);
    lfDebugTapTimer = setTimeout(() => { lfDebugTapCount = 0; }, 1500);
    if (lfDebugTapCount >= 5) {
      lfDebugTapCount = 0;
      const el = $('lfDebugLog');
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
  });

  // Maps raw provider/network errors to clean, non-technical copy - the raw
  // text still goes to lfDebug() (console + hidden log) for our own diagnosis.
  function lfFriendlyError(raw){
    const s = String(raw || '').toLowerCase();
    if (s.includes('concurrency') || s.includes('concurrent')) return 'Another live session is still open on your account (your plan allows only one at a time). Close it or wait a minute, then try again.';
    if (s.includes('credit') || s.includes('balance') || s.includes('quota') || s.includes('402') || s.includes('payment')) return 'Your Decart account is out of credits. Top up at platform.decart.ai, then try again.';
    if (s.includes('429') || s.includes('rate limit') || s.includes('too many')) return 'Too many sessions at once — wait a moment and try again.';
    if (s.includes('capacity') || s.includes('busy')) return 'Servers are busy right now — please try again in a moment.';
    if (s.includes('token') || s.includes('key') || s.includes('401') || s.includes('unauthorized')) return 'We couldn\u2019t verify your account. Check your API key in Profile \u2192 API.';
    if (s.includes('camera') || s.includes('permission')) return 'Camera access is required to start Live Swap.';
    if (s.includes('timed out') || s.includes('timeout')) return 'This is taking longer than expected. Please try again.';
    if (s.includes('lost') || s.includes('disconnected') || s.includes('failed')) return 'Connection lost. Please try again.';
    return 'Something went wrong starting Live Swap. Please try again.';
  }
  function lfShowError(raw){
    lfClearConnectTimer();
    lfDebug('error shown to user: ' + raw);
    $('lfPulse')?.classList.add('error');
    lfStatus.classList.add('error');
    lfStatus.textContent = lfFriendlyError(raw);
    // The friendly line hides the cause; add the provider's own words (trimmed)
    // so "Something went wrong" is never a dead end.
    let detail = '';
    try { detail = typeof raw === 'string' ? raw : (raw && (raw.message || raw.code)) || JSON.stringify(raw); } catch(_){}
    detail = String(detail || '').replace(/\s+/g, ' ').trim();
    if (detail && detail !== '[object Object]' && detail !== '{}') {
      const d = document.createElement('div');
      d.style.cssText = 'font-size:11.5px; opacity:0.7; margin-top:8px; word-break:break-word; max-width:320px; margin-left:auto; margin-right:auto;';
      d.textContent = 'Details: ' + detail.slice(0, 160);
      lfStatus.appendChild(d);
    }
    $('lfRetryBtn').style.display = 'inline-block';
  }
  function lfClearError(){
    $('lfPulse')?.classList.remove('error');
    lfStatus.classList.remove('error');
    $('lfRetryBtn').style.display = 'none';
  }
  $('lfRetryBtn')?.addEventListener('click', () => { lfClearError(); startLiveFilter(); });

  // Which realtime face-swap backend to use: the saved choice if its key exists,
  // otherwise whichever key the user has (Fal first).
  function lucyProvider(){
    let pref = 'fal';
    try { pref = localStorage.getItem('lucyProvider') || 'fal'; } catch(_){}
    if (pref === 'decart' && state.decartKeySet) return 'decart';
    if (pref === 'fal' && state.falKeySet) return 'fal';
    if (state.falKeySet) return 'fal';
    if (state.decartKeySet) return 'decart';
    return pref === 'decart' ? 'decart' : 'fal';
  }
  const lucyKeySet = () => state.falKeySet || state.decartKeySet;
  function updateLfKeyHint(){
    $('lfKeyHint').style.display = lucyKeySet() ? 'none' : 'block';
    $('lfStartBtn').disabled = !lucyKeySet();
  }

  $('openLfImageUpload')?.addEventListener('click', () => $('lfImageInput').click());
  async function uploadLfReference(file, statusEl, previewEl){
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      statusEl.textContent = 'Use a PNG, JPEG, or WEBP photo.'; return;
    }
    if (file.size > 4.5 * 1024 * 1024) {
      statusEl.textContent = 'Photo is too large — 4.5MB max.'; return;
    }
    try {
      statusEl.textContent = 'Uploading…';
      const thumbP = makeThumb(file);
      const ext = file.type.split('/')[1];
      const path = `${currentUser.id}/live-filter/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('user-uploads').upload(path, file, { contentType: file.type, upsert: true });
      if (upErr) { statusEl.textContent = 'Upload failed: ' + upErr.message; return; }
      const { data: pub } = supabase.storage.from('user-uploads').getPublicUrl(path);
      lfReferenceImageUrl = pub.publicUrl;
      lfReferenceDescription = '';
      lfReferencePath = path;
      lfRefThumb = await thumbP;
      saveLfRef();
      refreshHomeTiles();
      for (const el of [$('lfImagePreview'), previewEl]) { if (el) { el.src = lfReferenceImageUrl; el.style.display = 'block'; } }
      for (const el of [$('lfImageStatus'), statusEl]) { if (el && el !== statusEl) el.textContent = 'Reference photo ready'; }

      // Auto-describe the photo so the person never has to type a prompt -
      // Decart's docs say resemblance is weak without a literal description
      // of the reference in the prompt text, so we build that automatically.
      if (lucyProvider() === 'decart') {
        // Decart takes the reference photo itself; the text description is only
        // used by the Fal path, so don't make an extra call that can only fail.
        statusEl.textContent = 'Reference photo ready';
        return;
      }
      statusEl.textContent = 'Analyzing photo…';
      try {
        const dr = await fetch('/api/describe-reference', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
          body: JSON.stringify({ imageUrl: lfReferenceImageUrl }),
        });
        const dd = await dr.json();
        if (dr.ok && dd.description) {
          lfReferenceDescription = dd.description;
          saveLfRef();
          statusEl.textContent = 'Reference photo ready';
          lfDebug('Reference described: ' + dd.description);
        } else {
          statusEl.textContent = 'Reference photo added (auto-description failed: ' + String(dd.error || ('HTTP ' + dr.status)).slice(0, 90) + ' — will still work, just less precisely)';
          lfDebug('Describe-reference failed: ' + (dd.error || dr.status));
        }
      } catch (descErr) {
        statusEl.textContent = 'Reference photo added (auto-description failed — will still work, just less precisely)';
        lfDebug('Describe-reference error: ' + (descErr.message || descErr));
      }
    } catch (e) {
      statusEl.textContent = 'Upload failed: ' + (e.message || e);
    }
  }
  $('lfImageInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (file) uploadLfReference(file, $('lfImageStatus'), null);
  });
  $('openPrepLfImage')?.addEventListener('click', () => $('prepLfImageInput').click());
  $('prepLfImageInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (file) uploadLfReference(file, $('prepLfImageStatus'), $('prepLfImagePreview'));
  });

  const lfCallScreen = $('lfCallScreen'), lfIdle = $('lfIdle'), lfStatus = $('lfStatus'), lfBottom = $('lfBottom');
  const lfRemoteVideo = $('lfRemoteVideo'), lfLiveDot = $('lfLiveDot');
  let lfConnection = null, lfLocalStream = null, lfPc = null, lfConnectTimer = null, lfGotIceServers = false;

  function lfClearConnectTimer(){
    if (lfConnectTimer) { clearTimeout(lfConnectTimer); lfConnectTimer = null; }
  }

  // ---------------------------------------------------------------- Reusable Live Swap Media Source
  // Central reusable output layer for Decart Lucy 2.5 avatar stream.
  // Reused as outgoing video stream for WhatsApp calls, Telegram calls, and the Live Swap screen.
  const LiveSwapMediaSource = {
    stream: null,
    listeners: new Set(),
    forSocialCall: false,
    setStream(s){
      this.stream = s;
      this.listeners.forEach(fn => { try { fn(s); } catch(e){} });
    },
    getStream(){
      return this.stream || (lfRemoteVideo ? lfRemoteVideo.srcObject : null) || (lfPc && lfPc.getRemoteStreams ? lfPc.getRemoteStreams()[0] : null);
    },
    getVideoElement(){
      return lfRemoteVideo;
    },
    onStream(fn){
      this.listeners.add(fn);
      if (this.stream) fn(this.stream);
    },
    isActive(){
      return !!(this.stream || (lfPc && lfPc.connectionState === 'connected'));
    },
    async start(options = {}){
      this.forSocialCall = !!options.forSocialCall;
      await startLiveFilter(0, options);
    },
    stop(){
      this.forSocialCall = false;
      this.stream = null;
      endLiveFilter();
    }
  };

  // Fal's `fal.realtime.connect` client is only a signaling *relay* for this
  // model (and its VTON sibling) - it does not open the WebRTC peer connection
  // for you. `onResult` delivers the raw signaling messages Decart's realtime
  // service sends back (iceServers, sdp offer/answer, ice candidates,
  // ice-restart, prompt/image acks, errors), and the app is expected to build
  // its own RTCPeerConnection, attach the local camera track, exchange
  // SDP/ICE via `connection.send(...)`, and render the incoming remote track
  // into a <video> itself. There is no `stream`/`outputVideo` shorthand for
  // this endpoint - that only exists on Decart's native SDK, not @fal-ai/client.
  // Source: fal.ai/models/decart/lucy2-vton/realtime (same signaling shape
  // documented for decart/lucy-2-5/realtime).
  async function handleLfResult(result){
    // Temporary: surface every message type Fal actually sends so a failed
    // connection tells us exactly which step it got stuck on, instead of
    // guessing again. Safe to trim once this is confirmed working end-to-end.
    lfDebug(`onResult: ${result?.type} ${JSON.stringify(result).slice(0, 200)}`);

    switch (result.type) {
      case 'iceservers':
      case 'iceServers': {
        lfClearConnectTimer();
        lfGotIceServers = true;
        lfStatus.textContent = 'Connecting…';

        const servers = (result.iceservers || result.iceServers || result.ice_servers || [])
          .map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }));

        lfPc = new RTCPeerConnection({ iceServers: servers });
        lfLocalStream.getTracks().forEach((track) => lfPc.addTrack(track, lfLocalStream));

        lfPc.ontrack = (e) => {
          const stream = e.streams[0];
          lfRemoteVideo.srcObject = stream;
          LiveSwapMediaSource.setStream(stream);

          const socialVid = $('socialRemoteVideo');
          if (socialVid) { socialVid.srcObject = stream; socialVid.style.display = 'block'; }
          const prepVid = $('prepAvatarPreview');
          if (prepVid) {
            prepVid.srcObject = stream;
            prepVid.style.display = 'block';
            const ph = $('prepAvatarPlaceholder');
            if (ph) ph.style.display = 'none';
          }

          if (!LiveSwapMediaSource.forSocialCall) {
            if (lfRemoteVideo.style.display !== 'block') {
              lfRemoteVideo.style.display = 'block';
              lfIdle.style.display = 'none';
              lfLiveDot.classList.add('live');
              lfBottom.classList.remove('hidden');
            }
          } else {
            const idle = $('socialCallIdle');
            if (idle) idle.style.display = 'none';
            const lucySt = $('prepLucyStatus');
            if (lucySt) lucySt.textContent = 'Live & Streaming';
            $('prepLucyDot')?.classList.add('live');
          }
        };

        lfPc.onconnectionstatechange = () => {
          console.log('[LiveFilter] pc connectionState:', lfPc.connectionState);
          if (['failed', 'disconnected'].includes(lfPc.connectionState)) {
            lfIdle.style.display = 'flex';
            lfBottom.classList.add('hidden');
            lfLiveDot.classList.remove('live');
            lfShowError('connection lost');
          }
        };

        lfPc.onicecandidate = (e) => {
          if (e.candidate) {
            lfConnection.send({
              type: 'icecandidate',
              candidate: {
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex,
              },
            });
          }
        };

        const offer = await lfPc.createOffer();
        await lfPc.setLocalDescription(offer);
        lfConnection.send({ type: 'offer', sdp: offer.sdp });
        break;
      }
      case 'answer':
        if (lfPc) await lfPc.setRemoteDescription({ type: 'answer', sdp: result.sdp });
        break;
      case 'icecandidate':
        if (lfPc) await lfPc.addIceCandidate(new RTCIceCandidate(result.candidate));
        break;
      case 'ice-restart':
        if (result.turn_config && lfPc) {
          lfPc.setConfiguration({
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              {
                urls: result.turn_config.server_url,
                username: result.turn_config.username,
                credential: result.turn_config.credential,
              },
            ],
          });
          const offer = await lfPc.createOffer({ iceRestart: true });
          await lfPc.setLocalDescription(offer);
          lfConnection.send({ type: 'offer', sdp: offer.sdp });
        }
        break;
      case 'prompt_ack':
        if (!result.success) console.error('Prompt failed:', result.error);
        break;
      case 'set_image_ack':
        if (!result.success) console.error('Image failed:', result.error);
        break;
      case 'generation_started':
        break;
      case 'error':
        lfClearConnectTimer();
        console.error('Fal realtime server error:', result.error);
        lfShowError(result.error?.message || result.error || 'unknown');
        break;
      default:
        // An unrecognized message type means Fal is sending something this
        // switch doesn't handle yet - log it instead of silently ignoring it.
        console.log('[LiveFilter] Unhandled result type:', result?.type, result);
    }
  }

  // Mints a Fal realtime token directly, outside of the fal client, so a
  // failure here shows up as a specific, visible error instead of getting
  // swallowed inside fal.realtime.connect()'s internal tokenProvider call
  // (which is the leading suspect for a silent "Connecting…" hang that never
  // reaches Fal at all - if this never resolves/rejects visibly, nothing
  // downstream ever gets a chance to open the actual WebSocket).
  async function fetchLfToken(app){
    lfDebug(`requesting token for app: ${app}`);
    const r = await fetch('/api/fal-realtime-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ app }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const fp = body.keyFingerprint ? ` [key: ${body.keyFingerprint}]` : '';
      const msg = `Token request failed (${r.status}) for app "${app}": ${body.error || 'no error message'}${fp}`;
      lfDebug(msg);
      throw new Error(msg);
    }
    const token = await r.text();
    if (!token || token.trim().startsWith('{')) {
      const msg = `Server returned 200 but body isn't a token (looks like JSON): ${token.slice(0, 300)}`;
      lfDebug(msg);
      throw new Error(msg);
    }
    lfDebug(`got token for app "${app}", length: ${token?.length}, prefix: ${token?.slice(0, 12)}…`);
    return token;
  }

  // ---- Decart native realtime (lucy-latest). Uses a short-lived client token minted by
  // /api/fal-realtime-token {provider:'decart'} from the user's OWN Decart key.
  let lfDecart = null;
  async function startDecartLive(prompt){
    try {
      lfStatus.textContent = 'Connecting…';
      const tr = await fetch('/api/fal-realtime-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ provider: 'decart' }),
      });
      const tk = await tr.json().catch(() => ({}));
      if (!tr.ok || !tk.apiKey) throw new Error(tk.error || `Decart token request failed (${tr.status})`);

      const { createDecartClient, models } = await import('https://esm.sh/@decartai/sdk@0.2.4');
      const model = models.realtime('lucy-latest');
      // Use the model's own fps/size so Decart doesn't have to rescale.
      if (lfLocalStream) { lfLocalStream.getTracks().forEach(t => t.stop()); lfLocalStream = null; }
      lfLocalStream = await navigator.mediaDevices.getUserMedia({
        // model.fps is already a constraint object ({ ideal: 30, max: 30 }) in the
        // Decart SDK - wrapping it again made the browser reject the request with
        // "The provided value is non-finite". Accept either shape.
        video: {
          facingMode: 'user',
          frameRate: (typeof model.fps === 'number') ? { ideal: model.fps } : (model.fps || { ideal: 30 }),
          width: { ideal: Number(model.width) || 1088 },
          height: { ideal: Number(model.height) || 624 },
        },
      });
      const selfVid = $('socialSelfVideo');
      if (selfVid) selfVid.srcObject = lfLocalStream;

      const hasRef = !!lfReferenceImageUrl;
      const initialState = {};
      if (hasRef) {
        initialState.image = lfReferenceImageUrl;
        initialState.prompt = { text: 'Substitute the character in the video with the person in the reference image.', enhance: false };
      } else if (prompt) {
        initialState.prompt = { text: prompt, enhance: true };
      }

      const client = createDecartClient({ apiKey: tk.apiKey });
      lfStatus.textContent = 'Opening connection…';
      lfDecart = await client.realtime.connect(lfLocalStream, {
        model,
        onRemoteStream: (stream) => {
          lfRemoteVideo.srcObject = stream;
          LiveSwapMediaSource.setStream(stream);
          const socialVid = $('socialRemoteVideo');
          if (socialVid) { socialVid.srcObject = stream; socialVid.style.display = 'block'; }
          const prepVid = $('prepAvatarPreview');
          if (prepVid) {
            prepVid.srcObject = stream;
            prepVid.style.display = 'block';
            const ph = $('prepAvatarPlaceholder'); if (ph) ph.style.display = 'none';
          }
          if (!LiveSwapMediaSource.forSocialCall) {
            lfRemoteVideo.style.display = 'block';
            lfIdle.style.display = 'none';
            lfLiveDot.classList.add('live');
            lfBottom.classList.remove('hidden');
          } else {
            const idle = $('socialCallIdle'); if (idle) idle.style.display = 'none';
            const lucySt = $('prepLucyStatus'); if (lucySt) lucySt.textContent = 'Live & Streaming';
            $('prepLucyDot')?.classList.add('live');
          }
        },
        initialState: Object.keys(initialState).length ? initialState : undefined,
      });
      if (typeof lfDecart.on === 'function') {
        try { lfDecart.on('error', (e) => { lfDebug('decart error: ' + (e && e.message || e)); lfShowError((e && e.message) || 'Decart error'); }); } catch(_){}
      }
      lfDebug('decart realtime connected');
    } catch (e) {
      lfDebug('decart failed: ' + (e && e.message || e));
      lfShowError((e && e.message) || String(e));
    }
  }

  async function startLiveFilter(retryCount, { forSocialCall = false } = {}){
    retryCount = retryCount || 0;
    LiveSwapMediaSource.forSocialCall = !!forSocialCall;
    if (!lucyKeySet()) {
      if (forSocialCall) {
        // Fallback for social call if Fal key is not configured: activate user camera for the call
        try {
          if (lfLocalStream) { lfLocalStream.getTracks().forEach(t => t.stop()); lfLocalStream = null; }
          lfLocalStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } }
          });
          const socialVid = $('socialRemoteVideo');
          if (socialVid) { socialVid.srcObject = lfLocalStream; }
          const socialSelfVid = $('socialSelfVideo');
          if (socialSelfVid) { socialSelfVid.srcObject = lfLocalStream; }
          const prepVid = $('prepAvatarPreview');
          if (prepVid) { prepVid.srcObject = lfLocalStream; prepVid.style.display = 'block'; $('prepAvatarPlaceholder').style.display = 'none'; }
          LiveSwapMediaSource.setStream(lfLocalStream);
          const idle = $('socialCallIdle');
          if (idle) idle.style.display = 'none';
          $('prepLucyStatus').textContent = 'Camera ready';
          $('prepLucyDot')?.classList.add('live');
          return;
        } catch(e) {
          lfShowError('camera permission');
          return;
        }
      }
      updateLfKeyHint();
      return;
    }
    // The person never has to type anything: if a reference photo is set, its
    // strict auto-description IS the prompt. Anything typed in the box is an
    // ADDITIONAL instruction appended after it (e.g. a background change),
    // never a replacement for the description.
    const extra = $('lfPrompt').value.trim();
    let prompt;
    if (lfReferenceImageUrl && lfReferenceDescription) {
      prompt = `Substitute the character in the video with ${lfReferenceDescription}.`;
      if (extra) prompt += ` ${extra}`;
    } else {
      prompt = extra || undefined;
    }
    $('lfStartStatus').textContent = '';

    lfClearError();
    if (!forSocialCall) {
      lfCallScreen.classList.add('active');
      lfIdle.style.display = 'flex';
    }
    lfStatus.textContent = 'Connecting…';
    lfLiveDot.classList.remove('live');
    lfGotIceServers = false;
    lfClearConnectTimer();
    if (retryCount === 0) $('lfDebugLog').textContent = '';
    lfDebug(`fal client version check: importing esm.sh/@fal-ai/client@latest`);

    try {
      if (lfLocalStream) { lfLocalStream.getTracks().forEach(t => t.stop()); lfLocalStream = null; }
      // Constrained to Decart's documented native input spec for this model
      // (roughly 1088x624 @ 30fps) - capturing at an arbitrary resolution
      // makes the model work harder to reconcile mismatched input, which
      // shows up as both slower responses and less stable/consistent output.
      lfLocalStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1088 }, height: { ideal: 624 }, frameRate: { ideal: 30, max: 30 } },
      });
      const socialSelfVid = $('socialSelfVideo');
      if (socialSelfVid) { socialSelfVid.srcObject = lfLocalStream; }
    } catch (e) {
      lfShowError('camera permission');
      return;
    }

    // Decart (native SDK) path: its own signaling + WebRTC, returns the transformed stream directly.
    if (lucyProvider() === 'decart') {
      await startDecartLive(prompt);
      return;
    }

    // Prove the token endpoint itself works, with its own visible error,
    // before ever handing control to the fal client. If this step fails,
    // it explains a hang that never touches Fal (the WebSocket to Fal never
    // opens without a valid token) and points straight at /api/fal-realtime-token
    // or the saved Fal key rather than the WebRTC signaling logic.
    try {
      lfStatus.textContent = 'Connecting…';
      await fetchLfToken('decart/lucy-2-5/realtime');
    } catch (e) {
      lfDebug(`token fetch failed: ${e.message || e}`);
      lfShowError('key ' + (e.message || e));
      return;
    }

    try {
      lfStatus.textContent = 'Opening connection…';
      // Fal's realtime client - loaded from esm.sh the same way the Anam SDK
      // is above, so no build step / bundler is needed for this single-file app.
      const { fal } = await import('https://esm.sh/@fal-ai/client@latest');
      lfDebug('fal client module loaded');

      lfConnection = fal.realtime.connect('decart/lucy-2-5/realtime', {
        connectionKey: `lf-${Date.now()}`,
        throttleInterval: 0,
        tokenProvider: (app) => { lfDebug(`tokenProvider invoked by fal client with app="${app}"`); return fetchLfToken(app); },
        tokenExpirationSeconds: 120,
        onResult: handleLfResult,
        onError: (err) => {
          lfClearConnectTimer();
          const msg = err?.message || (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
          lfDebug(`onError fired: ${msg}`);
          lfShowError(msg);
        },
      });
      lfDebug(`fal.realtime.connect() returned, connection object: ${lfConnection ? 'created' : 'null/undefined'}`);

      // If we never even get the `iceservers` message back, the WebSocket to
      // Fal itself is the problem (network/CSP/auth) rather than anything in
      // the WebRTC offer/answer logic below it. A single stalled attempt is
      // common enough (cold start, transient network blip) that it's worth
      // one silent automatic retry before making the person manually restart -
      // only surface the error if it stalls twice in a row.
      lfConnectTimer = setTimeout(() => {
        if (!lfGotIceServers) {
          if (retryCount < 1) {
            lfDebug('45s elapsed, no response - retrying once automatically');
            lfStatus.textContent = 'Still connecting…';
            if (lfConnection) { try { lfConnection.close ? lfConnection.close() : null; } catch(e){} lfConnection = null; }
            startLiveFilter(retryCount + 1);
          } else {
            lfDebug('45s elapsed again on retry, no response - giving up');
            lfShowError('timed out');
          }
        }
      }, 45000);

      // Only the initial prompt/reference-image payload goes through the Fal
      // relay here - the actual WebRTC offer is sent once `handleLfResult`
      // receives the `iceservers` message above.
      const payload = {
        prompt: prompt || undefined,
        reference_image_url: lfReferenceImageUrl || undefined,
        // Off, not on: expansion rewrites/pads out what's sent with invented
        // extra detail, which is a plausible reason identity swap sometimes
        // only partially applies (clothes change, face doesn't) - keeping
        // the request literal keeps the reference's intent from getting
        // diluted by auto-added description.
        enable_prompt_expansion: false,
      };
      lfDebug(`sending initial payload: ${JSON.stringify(payload)}`);
      lfConnection.send(payload);
      lfDebug('initial payload sent, waiting for onResult/onError…');
    } catch (e) {
      lfClearConnectTimer();
      lfDebug(`failed to start (exception): ${e.message || e}`);
      lfShowError(e.message || e);
    }
  }

  function endLiveFilter(){
    lfClearConnectTimer();
    if (lfPc) { try { lfPc.close(); } catch(e){} lfPc = null; }
    if (lfConnection) { try { lfConnection.close ? lfConnection.close() : lfConnection.send({ close: true }); } catch(e){} lfConnection = null; }
    if (lfDecart) { try { lfDecart.disconnect(); } catch(e){} lfDecart = null; }
    if (lfLocalStream) { lfLocalStream.getTracks().forEach(t => t.stop()); lfLocalStream = null; }
    lfRemoteVideo.srcObject = null;
    lfRemoteVideo.style.display = 'none';
    lfLiveDot.classList.remove('live');
    lfBottom.classList.add('hidden');
    lfCallScreen.classList.remove('active');

    const socialVid = $('socialRemoteVideo');
    if (socialVid) socialVid.srcObject = null;
    const socialSelfVid = $('socialSelfVideo');
    if (socialSelfVid) socialSelfVid.srcObject = null;
    const prepVid = $('prepAvatarPreview');
    if (prepVid) { prepVid.srcObject = null; prepVid.style.display = 'none'; $('prepAvatarPlaceholder').style.display = 'block'; }
    LiveSwapMediaSource.stream = null;
    LiveSwapMediaSource.forSocialCall = false;
  }

  $('lfStartBtn')?.addEventListener('click', () => startLiveFilter());
  $('lfEndBtn')?.addEventListener('click', endLiveFilter);
  lfCallScreen.addEventListener('click', (e) => {
    if (e.target.closest('#lfTop') || e.target.closest('#lfBottom')) return;
    lfBottom.classList.toggle('hidden');
    $('lfTop').classList.toggle('hidden');
  });

  let muted = false;
  $('muteBtn')?.addEventListener('click', () => {
    muted = !muted;
    if (micStream) micStream.getAudioTracks().forEach(t => t.enabled = !muted);
    $('muteBtn').classList.toggle('muted', muted);
    $('muteBtn').innerHTML = muted
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M3 3l18 18"/><path d="M12 1a3 3 0 0 0-3 3v6.5M15 9V4a3 3 0 0 0-3-3"/><path d="M19 10v2a7 7 0 0 1-9.8 6.4M5 10v2a7 7 0 0 0 2 4.9"/><path d="M12 19v4"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/></svg>';
  });

  $('endBtn')?.addEventListener('click', endCall);

  // ==============================================================================
  // SOCIAL CALLING ARCHITECTURE (WhatsApp & Telegram with Lucy 2.5 Live Swap)
  // ==============================================================================

  // The WhatsApp/Telegram bridges (server.mjs + the Baileys/Pyrogram processes)
  // only run on the long-lived Render service - they can't live on Vercel's
  // serverless functions, which have no persistent process and no WebSocket
  // support. This app's static files are served from Vercel, so a *relative*
  // fetch('/api/social-call/...') resolves against the Vercel origin instead,
  // which has no matching route and answers with its own 404 HTML page -
  // res.json() then throws a JSON-parse error on that HTML body. Pointing
  // these calls at the Render origin explicitly is the fix.
  const SOCIAL_CALL_API_BASE = 'https://live-call-tbbk.onrender.com';

  // Every call to the social-call API carries the signed-in user's token: the
  // server uses it to pick THAT user's WhatsApp session and calls, and refuses
  // requests that have none. One wrapper here instead of touching every fetch.
  const _nativeFetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.startsWith(SOCIAL_CALL_API_BASE + '/api/social-call/')) {
        const headers = new Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || {});
        if (!headers.has('Authorization')) {
          const a = await authHeader();
          if (a.Authorization) headers.set('Authorization', a.Authorization);
        }
        init = { ...(init || {}), headers };
      }
    } catch(e){}
    return _nativeFetch(input, init);
  };
  let socialAccessToken = '';
  supabase.auth.getSession().then(({ data }) => { socialAccessToken = data?.session?.access_token || ''; });
  supabase.auth.onAuthStateChange((_evt, session) => { socialAccessToken = session?.access_token || ''; });

  let currentSocialPlatform = null; // 'whatsapp' | 'telegram'
  let selectedSocialContact = null; // { name, target }
  let selectedCallSource = 'lucy'; // 'lucy' | 'avatar' - which outgoing source to use for a social call
  let socialMicStream = null;
  let socialCallDurationTimer = null;
  // The WhatsApp engine that carried the CURRENT call, fixed at placement
  // time so a mid-call engine switch cannot send the teardown to the wrong
  // backend. null for Telegram.
  let currentCallEngine = null;

  // -----------------------------------------------------------------
  // WHATSAPP ENGINE SELECTION (provider layer)
  //
  // Two backends, chosen explicitly, never switched behind the user's back:
  //
  //   'greenapi'     - the original integration. Green API REST for
  //                    status/contacts/QR plus their browser calls SDK, which
  //                    is AUDIO ONLY (confirmed from that library's source).
  //   'wacalls'  - an external WaCalls instance, driven through server.mjs's
  //                /api/social-call/wacalls/* routes (server/wacalls.mjs).
  //                WaCalls is a real WhatsApp client: it pairs an account,
  //                places 1:1 calls and carries real VIDEO. The outgoing
  //                video is whichever avatar is selected (Anam or Lucy 2.5):
  //                this page encodes it to H.264 and pushes it over WaCalls'
  //                "vp8" data channel, while the call's audio rides its "pcm"
  //                channel. Green API's calls SDK has no video at all.
  //
  // The default stays 'greenapi' so nobody who was already calling through
  // Green API gets silently moved onto a different backend and a different
  // WhatsApp session.
  // -----------------------------------------------------------------
  const WA_ENGINES = {
    wacalls: {
      label: 'WaCalls',
      hint: 'Real WhatsApp calls, including 1:1 VIDEO with an AI avatar as the outgoing video. Link YOUR OWN WhatsApp number here - every account has its own separate session.',
    },
    greenapi: {
      label: 'Green API',
      hint: 'Your own Green API account. Calls are audio-only — their calls SDK has no video support.',
    },
  };
  const WA_ENGINE_KEY = 'livecall.whatsappEngine';

  function waEngine(){
    const saved = (() => { try { return localStorage.getItem(WA_ENGINE_KEY); } catch(e){ return null; } })();
    return (saved && WA_ENGINES[saved]) ? saved : 'wacalls';
  }
  function setWaEngine(engine){
    if (!WA_ENGINES[engine]) return;
    try { localStorage.setItem(WA_ENGINE_KEY, engine); } catch(e){}
    renderWaEngineUi();
  }
  function waEngineLabel(engine){
    return (WA_ENGINES[engine || waEngine()] || WA_ENGINES.greenapi).label;
  }

  // Headless Anam avatar source for social calls - mirrors LiveSwapMediaSource's
  // shape (getStream/getVideoElement/start/stop) so the rest of the social-call
  // code can treat "Lucy 2.5" and "Avatar" interchangeably. Deliberately uses
  // its own client/video element, separate from callScreen's own anamClient/
  // remoteVideo, so starting a social avatar call can never interfere with
  // the regular AI-avatar call screen (which stays exactly as it was).
  // Draws a video into a canvas the way CSS object-fit:cover would: fills the whole canvas,
  // keeps the picture's proportions and crops the overflow (no stretching).
  // H264-START
  // ---- H.264 helpers: the call server needs Annex-B (start-code delimited, SPS/PPS before each keyframe) ----
  function h264Format(b){
    if (b.length > 3 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1))) return 'annexb';
    return 'avcc';
  }
  function h264HasParamSets(b){
    let sps = false, pps = false;
    for (let i = 0; i + 4 < b.length && i < 4096; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && b[i + 3] === 1))) {
        const nal = b[i + (b[i + 2] === 1 ? 3 : 4)] & 0x1f;
        if (nal === 7) sps = true; if (nal === 8) pps = true;
      }
    }
    return sps && pps;
  }
  function avcCParamSets(desc){
    // avcC: [0]=1 [1..3]=profile/compat/level [4]=0xFC|lenSize-1 [5]=0xE0|numSPS ... then PPS
    const out = []; if (!desc || desc.length < 8) return out;
    let o = 5; const nSps = desc[o++] & 0x1f;
    for (let i = 0; i < nSps && o + 2 <= desc.length; i++) { const l = (desc[o] << 8) | desc[o + 1]; o += 2; out.push(desc.subarray(o, o + l)); o += l; }
    const nPps = desc[o++] || 0;
    for (let i = 0; i < nPps && o + 2 <= desc.length; i++) { const l = (desc[o] << 8) | desc[o + 1]; o += 2; out.push(desc.subarray(o, o + l)); o += l; }
    return out;
  }
  function concatNals(nals){
    let n = 0; nals.forEach((x) => { n += 4 + x.length; });
    const out = new Uint8Array(n); let o = 0;
    nals.forEach((x) => { out[o++] = 0; out[o++] = 0; out[o++] = 0; out[o++] = 1; out.set(x, o); o += x.length; });
    return out;
  }
  function prependParamSets(annexb, desc){
    const ps = concatNals(avcCParamSets(desc));
    const out = new Uint8Array(ps.length + annexb.length); out.set(ps, 0); out.set(annexb, ps.length); return out;
  }
  // Length-prefixed (AVCC) access unit -> Annex-B. Keyframes get SPS/PPS from the avcC description.
  // Returns null if the bytes do not parse.
  function avccToAnnexB(b, desc, isKey){
    const lenSize = (desc && desc.length > 4) ? ((desc[4] & 3) + 1) : 4;
    const nals = [];
    if (isKey && desc) avcCParamSets(desc).forEach((x) => nals.push(x));
    let o = 0;
    while (o + lenSize <= b.length) {
      let l = 0; for (let i = 0; i < lenSize; i++) l = (l * 256) + b[o + i];
      o += lenSize;
      if (l <= 0 || o + l > b.length) return null;
      nals.push(b.subarray(o, o + l)); o += l;
    }
    if (o !== b.length || !nals.length) return null;
    return concatNals(nals);
  }
  // H264-END
  function drawCover(ctx, vid, cw, ch){
    const vw = vid.videoWidth, vh = vid.videoHeight;
    if (!vw || !vh) { ctx.drawImage(vid, 0, 0, cw, ch); return; }
    const scale = Math.max(cw / vw, ch / vh);
    const sw = cw / scale, sh = ch / scale;
    ctx.drawImage(vid, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, cw, ch);
  }
  // Asks the server to force-end every running Anam session (Anam's own stop-session API),
  // instead of trusting the browser's WebRTC close to be noticed quickly.
  let anamAuthCache = null, anamStopPromise = null;
  function stopAnamSessions({ keepalive = false } = {}){
    const run = async () => {
      try {
        const h = keepalive && anamAuthCache ? anamAuthCache : await authHeader();
        anamAuthCache = h;
        const r = await fetch('/api/anam', {
          method: 'POST', keepalive,
          headers: { 'Content-Type': 'application/json', ...h },
          body: JSON.stringify({ action: 'stop-active' }),
        });
        if (keepalive) return null;
        const d = await r.json().catch(() => null);
        try { trace(r.ok && d ? `anam: ${d.found} running session(s) found, ${d.stopped} stopped` : `anam: stop-active failed (HTTP ${r.status})`); } catch(_){}
        return r.ok ? d : null;
      } catch(e){ console.warn('[avatar] stop-active failed:', e && e.message); return null; }
    };
    anamStopPromise = run();
    return anamStopPromise;
  }
  async function stopAnamSession(sessionId){
    if (!sessionId) return;
    try {
      const h = anamAuthCache || await authHeader();
      await fetch('/api/anam', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', ...h },
        body: JSON.stringify({ action: 'stop-session', sessionId }),
      });
    } catch(e){ console.warn('[avatar] stop-session failed:', e && e.message); }
  }
  const SocialAnamSource = {
    client: null,
    videoEl: null,
    // Bumped by stop(). Every await in start() re-checks it, so a start() that
    // is still in flight when the call is cancelled/timed out can never attach
    // a live avatar session afterwards (the orphaned "avatar already talking,
    // no call screen, no End button" state).
    gen: 0,
    transcript: [],
    // Called once the call is connected (+5s). Unmutes what the avatar hears and tells it, in words it
    // was prepared for (see the [CALL EVENT] rule in lib/anamPrompt.js), that the person is on the line.
    notifyCallConnected(name, note){
      const c = this.client; if (!c) return false;
      try { const cs = CalleeAudioBus.stream && CalleeAudioBus.stream(); if (cs) cs.getAudioTracks().forEach((t) => { t.enabled = true; }); } catch(_){}
      try { c.unmuteInputAudio(); } catch(_){}
      const who = name || 'the person you called';
      const msg = note || `[CALL EVENT] The call has just connected and ${who} is on the line. Say a short, natural hello in your own words, then follow their lead.`;
      try { c.sendUserMessage(msg); } catch(e){ console.warn('[avatar] could not send the call-connected event:', e && e.message); return false; }
      return true;
    },
    getVideoElement(){ return this.videoEl; },
    getStream(){ return this.videoEl && this.videoEl.captureStream ? this.videoEl.captureStream() : null; },
    isActive(){ return !!this.client; },
    // The avatar's own voice (audio track of the stream Anam plays into the
    // preview element) - what the callee has to hear.
    getAudioStream(){
      const so = this.videoEl && this.videoEl.srcObject;
      const tracks = so && so.getAudioTracks ? so.getAudioTracks() : [];
      return tracks.length ? new MediaStream(tracks) : null;
    },
    async start(){
      const gen = ++this.gen;
      const stale = () => gen !== this.gen;
      if (this.client) { try { await this.client.stopStreaming(); } catch(e){} this.client = null; }
      if (anamClient) { try { await anamClient.stopStreaming(); } catch(e){} anamClient = null; }
      if (this.closing) { await Promise.race([this.closing, new Promise(r => setTimeout(r, 4000))]); this.closing = null; }
      if (anamStopPromise) await Promise.race([anamStopPromise, new Promise(r => setTimeout(r, 4000))]);
      if (stale()) return;
      // In a WaCalls avatar call this is the callee's voice; otherwise null and
      // the SDK behaves exactly as before (its own microphone).
      const calleeStream = CalleeAudioBus.stream();
      const vid = $('prepAvatarPreview');
      this.videoEl = vid;
      if (!state.testAvatar && !state.anamKeySet) throw new Error('Add your Anam API key in Profile settings first.');
      if (!state.testAvatar && !state.anamAvatarId) throw new Error('Pick an avatar first.');
      // Token and SDK load in parallel (both are slow on a cold start).
      const [data, sdk] = state.testAvatar
        ? [{ sessionToken: 'test' }, { createClient: createTestAvatarClient, AnamEvent: TEST_EVENTS }]
        : await Promise.all([mintAnamSession(), loadAnamSdk()]);
      if (stale()) throw new Error('Avatar start was cancelled');
      const { createClient, AnamEvent } = sdk;
      const client = createClient(data.sessionToken);
      this.client = client;
      // During a call the avatar's voice goes to the callee over the call; it
      // is not also played out loud here.
      vid.muted = !!calleeStream;
      vid.volume = 1.0;
      vid.style.display = 'block';
      $('prepAvatarPlaceholder').style.display = 'none';
      const idle = $('socialCallIdle');
      let videoStartedResolve; const videoStarted = new Promise(r => { videoStartedResolve = r; });
      client.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
        videoStartedResolve();
        if (stale()) return;
        if (idle) idle.style.display = 'none';
        $('prepLucyStatus').textContent = 'Avatar ready';
        $('prepLucyDot')?.classList.add('live');
        // The bug: Anam's SDK streams into prepAvatarPreview (which also
        // feeds the OUTGOING call capture), but nothing ever mirrored that
        // onto socialRemoteVideo - the actual on-screen big view during a
        // call. Only LiveSwapMediaSource's own WebRTC handler ever touched
        // socialRemoteVideo, so Avatar mode's screen stayed black even
        // though the avatar itself was working and being sent out fine.
        const remoteVid = $('socialRemoteVideo');
        if (remoteVid && vid.srcObject) remoteVid.srcObject = vid.srcObject;
      });
      this.transcript = [];
      client.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, (msgs) => {
        // Full history each time. Kept after the call ends so the summary can use it.
        try { this.transcript = (msgs || []).map((m) => ({ role: m.role, content: m.content })); } catch(_){}
      });
      client.addListener(AnamEvent.CONNECTION_CLOSED, (code, details) => {
        if (this.client === client) this.client = null;
        if (stale()) return;
        const why = anamCloseReason(code, details);
        trace('avatar connection closed: ' + why);
        console.warn('[avatar] Anam connection closed:', code, details || '');
        if (!$('socialCallScreen')?.classList.contains('active')) return;
        // On a WhatsApp call the avatar is just one half of it: losing the avatar
        // used to hang up the whole call with no explanation. Say why and try to
        // bring the avatar back once instead.
        if (calleeStream && WaCallsMediaLeg.active) { recoverAvatar(why); return; }
        endSocialCall();
      });
      try { client.addListener(AnamEvent.SERVER_WARNING, (m) => console.warn('[avatar] Anam server warning:', m)); } catch(_){}
      // Gated start: the callee-audio stream carries silence until the call connects, but disable it
      // outright (and mute the SDK input) so nothing can reach the persona before we say so.
      const gate = avatarGateActive && !avatarGreeted && !!calleeStream;
      if (gate) { try { calleeStream.getAudioTracks().forEach((t) => { t.enabled = false; }); } catch(_){} }
      await client.streamToVideoElement('prepAvatarPreview', calleeStream || undefined);
      if (gate) { try { client.muteInputAudio(); } catch(_){} trace('avatar: started, muted until the call connects'); }
      // "Connected" is not "on screen": make sure video is really playing, otherwise fail now so the
      // caller restarts the avatar (what the second attempt did anyway) instead of calling with nothing.
      await Promise.race([
        videoStarted,
        new Promise((_, rej) => setTimeout(() => rej(new Error('The avatar connected but no video arrived')), 10000)),
      ]);
      if (stale()) {
        let sid = null; try { sid = client.getActiveSessionId && client.getActiveSessionId(); } catch(_){}
        try { client.stopStreaming(); } catch(e){}
        stopAnamSession(sid);
        return;
      }

      // NOTE: no getUserMedia({video}) here any more. Avatar mode never needs
      // the caller's camera; it used to be opened only to fill the small PIP
      // with the caller's own face (and light the camera indicator). The PIP
      // now carries the PERSON BEING CALLED - see PeerMediaPlayout.attachToPip.
    },
    lastStopAt: 0,
    closing: null,
    stop(){
      this.gen++;
      const c = this.client; this.client = null;
      if (c) {
        this.lastStopAt = Date.now();
        // stopStreaming() is async: keep the promise so the next start() can wait for Anam to free the session.
        try { this.closing = Promise.resolve(c.stopStreaming()).catch(() => {}); } catch(e){ this.closing = null; }
        let sid = null; try { sid = c.getActiveSessionId && c.getActiveSessionId(); } catch(_){}
        if (sid) this.closing = Promise.all([this.closing, stopAnamSession(sid)]);
      }
      try {
        const so = this.videoEl && this.videoEl.srcObject;
        if (so && so.getTracks) so.getTracks().forEach(t => { try { t.stop(); } catch(_){} });
        if (this.videoEl) this.videoEl.srcObject = null;
      } catch(_){}
      if (this.videoEl) { this.videoEl.style.display = 'none'; }
      const ph = $('prepAvatarPlaceholder');
      if (ph) ph.style.display = 'block';
      if (lfLocalStream) { lfLocalStream.getTracks().forEach(t => t.stop()); lfLocalStream = null; }
      const selfVid = $('socialSelfVideo');
      if (selfVid) selfVid.srcObject = null;
      const remoteVid = $('socialRemoteVideo');
      if (remoteVid) remoteVid.srcObject = null;
    },
  };

  function activeSocialSource(){
    return selectedCallSource === 'avatar' ? SocialAnamSource : LiveSwapMediaSource;
  }

  // Both selectors (this prep screen and the in-call one) go through
  // setSocialCallAvatarSource(), so whichever the user touches, the other
  // reflects it and the running media leg switches to the new source.
  $('prepSourceLucyBtn')?.addEventListener('click', () => {
    setSocialCallAvatarSource('lucy');
    $('prepPreviewPlaceholderLabel').textContent = 'Lucy 2.5 Live Swap Preview';
    $('prepLucyStatus').textContent = 'Ready to stream';
  });
  $('prepSourceAvatarBtn')?.addEventListener('click', () => {
    setSocialCallAvatarSource('anam');
    $('prepPreviewPlaceholderLabel').textContent = 'AI Avatar Preview';
    $('prepLucyStatus').textContent = state.anamAvatarId ? 'Ready to stream' : 'Pick an avatar in Profile first';
    // Voice conversion is Lucy 2.5 only - an Anam avatar already brings its
    // own synthesised voice, so the control is meaningless (and hidden) here.
    LucyVoice.renderVoiceUi();
  });

  // ==============================================================================
  // REALTIME RVC VOICE CONVERSION (Lucy 2.5 Live Swap only)
  // ==============================================================================
  //
  // Lucy 2.5 (decart/lucy-2-5/realtime) is a video-to-video model: it gives
  // us the live avatar and NO voice. The audio that goes out with the avatar
  // is the live audio paired with that pipeline (the microphone track the
  // app already streams up as outgoing call audio). This converts that live
  // stream, in real time, with RVC through w-okada/voice-changer.
  //
  // Where the conversion happens is decided by how each platform carries its
  // outgoing media, not by preference:
  //
  //   Telegram - the call's outgoing audio is server-side (tgcalls_bridge
  //             reads /tmp/tgcalls_audio.pcm), so the server converts there
  //             and writes the converted voice into that pipe: it becomes
  //             the audio track that travels with the Lucy video.
  //
  //   WhatsApp - the call is browser-side WebRTC (Green API calls SDK), so
  //             the server streams the converted PCM back here (WS channel
  //             0x04) and we hand it to the call as its outgoing audio track.
  //
  // Nothing here is prerecorded, nothing waits for a sentence to finish, and
  // there is no TTS/LLM anywhere in this path: it is a continuous stream of
  // audio in / audio out for the whole call. Incoming caller audio is never
  // touched.
  const LucyVoice = {
    enabled: false,      // user's choice for the next call
    running: false,      // a conversion session is live for this call
    models: [],
    selectedSlot: null,
    status: null,
    mode: 'off',         // 'off' | 'convert' | 'bypass'
    error: null,
    pollTimer: null,

    serverReachable(){
      return !!this.status && this.status.connected === true;
    },
    canEnable(){
      return this.serverReachable() && this.models.length > 0;
    },

    async refresh(){
      try {
        const [statusRes, modelsRes] = await Promise.all([
          fetch(SOCIAL_CALL_API_BASE + '/api/social-call/voice/status'),
          fetch(SOCIAL_CALL_API_BASE + '/api/social-call/voice/models'),
        ]);
        const status = await statusRes.json().catch(() => null);
        const models = await modelsRes.json().catch(() => null);
        this.status = status || null;
        this.models = (models && Array.isArray(models.models)) ? models.models : [];
        this.mode = status?.mode || 'off';
        this.error = status?.error || null;
        if (this.selectedSlot === null && models && Number.isInteger(models.selectedSlot) && models.selectedSlot >= 0) {
          this.selectedSlot = models.selectedSlot;
        }
      } catch (e) {
        this.status = null;
        this.models = [];
        this.error = e.message;
      }
      // Never leave the toggle on something that cannot actually convert -
      // that would look like it is converting when it isn't.
      if (this.enabled && !this.canEnable()) this.enabled = false;
      this.renderVoiceUi();
      return this.status;
    },

    applyStatus(status){
      if (!status || typeof status !== 'object') return;
      this.status = status;
      this.mode = status.mode || 'off';
      this.error = status.error || null;
      this.renderVoiceUi();
      this.renderCallBadge();
    },

    async select(slot){
      this.selectedSlot = Number(slot);
      try {
        await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/voice/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot: this.selectedSlot }),
        });
      } catch (e) {
        this.error = e.message;
      }
      await this.refresh();
    },

    // Called once the call is actually being placed, so conversion is only
    // ever running for a live call.
    async startForCall(platform){
      this.running = true;
      SocialCallMediaAdapter.sendControl({
        type: 'vc_start',
        platform,
        modelSlot: this.selectedSlot,
      });
      this.renderCallBadge();
      this.refresh();
      this.startPolling();
    },

    stopForCall(){
      this.running = false;
      this.stopPolling();
      SocialCallMediaAdapter.sendControl({ type: 'vc_stop' });
      this.renderCallBadge();
    },

    startPolling(){
      this.stopPolling();
      // Keeps the on-call badge honest: it shows whether we are really
      // converting right now (and how long a conversion is taking), not
      // whether we merely asked to.
      this.pollTimer = setInterval(() => {
        if (!this.running) return this.stopPolling();
        SocialCallMediaAdapter.sendControl({ type: 'vc_status' });
      }, 2000);
    },
    stopPolling(){
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    },

    modelName(){
      const m = this.models.find((x) => x.slot === this.selectedSlot);
      return m ? m.name : null;
    },

    renderVoiceUi(){
      const card = $('prepVoiceCard');
      if (!card) return;
      const modelCard = $('prepVoiceModelCard');
      const statusEl = $('prepVoiceStatus');
      const hintEl = $('prepVoiceHint');
      const toggle = $('prepVoiceToggle');
      // Lucy 2.5 only - the whole block (card, model picker and hint) is
      // hidden for the Anam avatar source, which already has a voice.
      const lucy = selectedCallSource === 'lucy';
      card.style.display = lucy ? '' : 'none';
      const picCard = $('prepLfImageCard'); if (picCard) picCard.style.display = lucy ? '' : 'none';
      if (modelCard) modelCard.style.display = 'none';
      if (hintEl) hintEl.style.display = 'none';
      if (!lucy) return;

      if (toggle) {
        toggle.classList.toggle('on', this.enabled);
        toggle.setAttribute('aria-checked', this.enabled ? 'true' : 'false');
        toggle.disabled = !this.canEnable();
      }

      if (!statusEl) return;
      if (!this.serverReachable()) {
        statusEl.textContent = 'Converter offline — your own voice is sent';
        if (hintEl) hintEl.textContent = 'The realtime voice-changer service is not running on the call backend, so nothing would be converted.';
      } else if (!this.models.length) {
        statusEl.textContent = 'No RVC model loaded';
        if (hintEl) hintEl.textContent = 'Load an RVC model on the backend (or pick one in voice-changer\'s own UI) to convert your voice.';
      } else if (this.enabled) {
        statusEl.textContent = 'On — converting with ' + (this.modelName() || `slot ${this.selectedSlot}`);
        if (hintEl) hintEl.textContent = 'Your live voice is converted in real time and sent with the Lucy 2.5 video.';
      } else {
        statusEl.textContent = 'Off — your own voice is sent';
        if (hintEl) hintEl.textContent = 'Turn on to convert the voice that goes out with the Lucy 2.5 avatar, in real time.';
      }
      if (hintEl) hintEl.style.display = '';
      if (modelCard) modelCard.style.display = (this.enabled && this.models.length) ? '' : 'none';

      // Keep the model picker in sync with what the server has.
      const select = $('prepVoiceModelSelect');
      if (select) {
        const wanted = this.selectedSlot === null ? '' : String(this.selectedSlot);
        select.innerHTML = this.models.length
          ? this.models.map((m) => `<option value="${m.slot}">${m.name}${m.samplingRate ? ` · ${Math.round(m.samplingRate / 1000)}kHz` : ''}</option>`).join('')
          : '<option value="">No RVC models on the server</option>';
        select.value = wanted;
        if (select.value !== wanted && this.models.length) select.value = String(this.models[0].slot);
        if (this.models.length) this.selectedSlot = Number(select.value);
      }
    },

    renderCallBadge(){
      const badge = $('socialCallVoiceBadge');
      if (!badge) return;
      if (!this.running) { badge.style.display = 'none'; return; }
      badge.style.display = 'inline-block';
      if (this.mode === 'convert') {
        const ms = this.status?.stats?.inferenceMs;
        const queued = this.status?.stats?.queuedMs || 0;
        badge.textContent = ms ? `RVC · ${ms}ms${queued > 120 ? ' · busy' : ''}` : 'RVC';
        badge.style.background = 'rgba(37,211,102,0.22)';
        badge.style.color = '#25D366';
      } else {
        // Being explicit: the call is running with the real voice because
        // conversion could not be used, not because it is warming up.
        badge.textContent = 'RVC OFF';
        badge.style.background = 'rgba(255,255,255,0.14)';
        badge.style.color = 'var(--dim)';
      }
    },
  };

  $('prepVoiceToggle')?.addEventListener('click', () => {
    // Refusing to switch on when there is nothing to convert with is
    // deliberate - an "on" switch that quietly sends your own voice would be
    // a lie. A click in that state just re-checks the server.
    if (!LucyVoice.canEnable()) { LucyVoice.refresh(); return; }
    LucyVoice.enabled = !LucyVoice.enabled;
    LucyVoice.renderVoiceUi();
  });
  $('prepVoiceModelSelect')?.addEventListener('change', (e) => {
    LucyVoice.select(e.target.value);
  });

  // Plays the converted audio the server streams back (WhatsApp calls carry
  // their audio from this browser, so the converted voice has to reach the
  // WebRTC track here). It is a jitter-buffered playout, not monitoring: the
  // converted voice is never played out loud, only handed to the call.
  const VoiceConversionPlayout = {
    ctx: null, node: null, dest: null, muteGain: null, stream: null, track: null,
    queue: [], queued: 0, started: false, firstChunkAt: 0, chunks: 0,
    maxQueue: 16000 * 0.4, // 400ms - enough to ride out network jitter, small
                           // enough that added latency stays imperceptible

    async start(){
      if (this.started) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ sampleRate: 16000 });
      this.dest = this.ctx.createMediaStreamDestination();
      this.stream = this.dest.stream;
      this.track = this.stream.getAudioTracks()[0] || null;
      // Safari only pulls a ScriptProcessorNode that reaches ctx.destination,
      // so the playout is connected there through a zero gain: the graph runs,
      // but the converted voice is never audible (that would echo straight
      // back into the call).
      this.muteGain = this.ctx.createGain();
      this.muteGain.gain.value = 0;
      this.node = this.ctx.createScriptProcessor(512, 1, 1);
      this.node.onaudioprocess = (evt) => this._fill(evt.outputBuffer.getChannelData(0));
      this.node.connect(this.dest);
      this.node.connect(this.muteGain);
      this.muteGain.connect(this.ctx.destination);
      this.started = true;
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch (e) {}
      }
    },

    _fill(out){
      let written = 0;
      while (written < out.length && this.queued > 0) {
        const head = this.queue[0];
        const need = out.length - written;
        if (head.length <= need) {
          for (let i = 0; i < head.length; i++) out[written + i] = head[i] / 32768;
          written += head.length;
          this.queued -= head.length;
          this.queue.shift();
        } else {
          for (let i = 0; i < need; i++) out[written + i] = head[i] / 32768;
          written += need;
          this.queue[0] = head.subarray(need);
          this.queued -= need;
        }
      }
      // Underrun: play silence rather than repeat or stretch anything.
      if (written < out.length) out.fill(0, written);
    },

    // Optional consumer of the converted samples, set by the WaCalls media leg
    // (which puts them on the call's own outgoing data channel). The Green API
    // path consumes `stream` as an outgoing WebRTC track instead; both can be
    // set, each simply ignores what it does not need.
    sink: null,

    onConverted(int16){
      if (!this.started || !int16 || !int16.length) return;
      if (!this.firstChunkAt) this.firstChunkAt = Date.now();
      this.chunks++;
      if (this.sink) {
        try { this.sink(int16); } catch (e) {}
      }
      this.queue.push(int16);
      this.queued += int16.length;
      while (this.queued > this.maxQueue && this.queue.length > 1) {
        this.queued -= this.queue.shift().length;
      }
    },

    // True once converted audio has actually arrived, which is what decides
    // whether the call can be handed a converted track at all.
    async waitForAudio(timeoutMs){
      const deadline = Date.now() + timeoutMs;
      while (!this.firstChunkAt && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return !!this.firstChunkAt;
    },

    getTrack(){
      return (this.started && this.track && this.track.readyState === 'live') ? this.track : null;
    },

    /**
     * Makes the Green API calls SDK send the converted voice instead of the
     * microphone. Its CallsConnection keeps the RTCPeerConnection in a
     * private field, and startAudioBridge() calls
     * navigator.mediaDevices.getUserMedia({ audio: true }) to get the track
     * it adds to that connection - so answering that request is the only
     * supported way to choose what the call transmits. The hijack is scoped
     * to the single startAudioBridge() call and undone immediately after.
     */
    interceptMicrophone(){
      const md = navigator.mediaDevices;
      if (!md || typeof md.getUserMedia !== 'function') return null;
      const original = md.getUserMedia.bind(md);
      const self = this;
      let active = true;
      try {
        md.getUserMedia = function (constraints) {
          const audioOnly = constraints && constraints.audio && !constraints.video;
          if (active && audioOnly && self.getTrack()) {
            try {
              // A clone: the SDK stops the tracks it was given when it tears
              // the bridge down, which must not kill our playout track.
              return Promise.resolve(new MediaStream([self.getTrack().clone()]));
            } catch (e) { /* fall through to the real microphone */ }
          }
          return original(constraints);
        };
      } catch (e) {
        return null;
      }
      return function restore(){
        active = false;
        try { md.getUserMedia = original; } catch (e) {}
      };
    },

    stop(){
      this.started = false;
      this.queue = [];
      this.queued = 0;
      this.firstChunkAt = 0;
      this.chunks = 0;
      if (this.node) { try { this.node.disconnect(); this.node.onaudioprocess = null; } catch (e) {} this.node = null; }
      if (this.muteGain) { try { this.muteGain.disconnect(); } catch (e) {} this.muteGain = null; }
      if (this.track) { try { this.track.stop(); } catch (e) {} this.track = null; }
      if (this.dest) { try { this.dest.disconnect(); } catch (e) {} this.dest = null; }
      this.stream = null;
      if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
    },
  };

  // The live audio that goes out with the Lucy 2.5 avatar. Lucy 2.5 is a
  // video-to-video model and emits no audio of its own, so this is the local
  // microphone - unless the avatar pipeline itself exposes an audio track, in
  // which case that is what belongs here (and is what gets converted).
  function outgoingCallAudioStream(){
    const src = LiveSwapMediaSource.getStream();
    if (src && src.getAudioTracks && src.getAudioTracks().length) {
      return new MediaStream(src.getAudioTracks());
    }
    return socialMicStream;
  }

  // Binary frame dispatch lives in the single unified handleMediaWsBinary
  // below (length-prefixed, channel-tagged) - see its definition for the
  // full channel list, including 0x06 for RVC-converted outgoing audio.

  let socialCallStartedAt = null;
  let socialMuted = false;
  let waStatusPollTimer = null;

  // =============================================================================
  // AvatarMediaSource - the one interface both avatars satisfy.
  //
  //   AvatarMediaSource
  //     +-- LiveSwapMediaSource   (Lucy 2.5 / Fal-Decart realtime face swap)
  //     +-- SocialAnamSource      (Anam AI avatar)
  //            |
  //            v  activeSocialSource()
  //     SocialCallMediaAdapter  (JPEG @15fps + 16k mono PCM, channel-tagged)
  //            |
  //            v  /api/social-call/media  ->  server.mjs
  //            +-- WhatsApp: WaCallsMediaLeg -> H.264 access units on WaCalls'
  //                "vp8" data channel + 16 kHz PCM on its "pcm" channel ->
  //                a REAL WhatsApp 1:1 call (audio and video)
  //            +-- Telegram: tgcalls/madeline pipes (unchanged)
  //
  // Contract (both implementations already had exactly this shape - nothing
  // was rewritten, it is just named so a third avatar can be added without
  // touching any call code):
  //   getStream()       -> MediaStream of the live avatar output (or null)
  //   getVideoElement() -> the <video> currently rendering that output
  //   isActive()        -> boolean
  //   start(options)    -> async, begins producing live output
  //   stop()            -> tears the avatar down
  //
  // The adapter below reads getVideoElement() and never asks which avatar it
  // is, which is why Lucy and Anam both feed the WhatsApp Rust backend with
  // no provider-specific branch anywhere.
  // =============================================================================

  // -------------------------------------------------------------
  // Peer media coming BACK from a WhatsApp call: decoded and played here.
  // Audio is decoded trivially (raw 16 kHz mono PCM); video uses WebCodecs when
  // the browser has it, and is simply counted when it does not - never faked
  // either way. Used by WaCallsMediaLeg (the peer's audio and video arrive on
  // WaCalls' own "pcm" / "vp8" data channels) and by the media-socket peer
  // channels (0x03/0x04) that engines with server-side media use.
  // The CALLEE's voice as a MediaStream. WaCalls delivers it as raw 16 kHz PCM
  // on the "pcm" data channel; this turns it into a stream the Anam avatar can
  // use as ITS microphone, so in avatar mode the avatar listens to the person
  // being called and the caller's own mic is never opened.
  const CalleeAudioBus = {
    ctx: null, dest: null, next: 0, active: false,
    start(){
      if (this.active) return this.dest.stream;
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ sampleRate: 16000 });
      this.dest = this.ctx.createMediaStreamDestination();
      this.next = 0;
      this.active = true;
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.dest.stream;
    },
    stream(){ return this.active ? this.dest.stream : null; },
    push(int16){
      if (!this.active || !int16 || !int16.length) return;
      try {
        const ctx = this.ctx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const f32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000;
        const buf = ctx.createBuffer(1, f32.length, 16000);
        buf.copyToChannel(f32, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.dest);
        const now = ctx.currentTime;
        if (this.next < now) this.next = now + 0.04;
        src.start(this.next);
        this.next += buf.duration;
      } catch(e) {}
    },
    stop(){
      this.active = false;
      if (this.ctx) { try { this.ctx.close(); } catch(e){} }
      this.ctx = null; this.dest = null; this.next = 0;
    },
  };

  const PeerMediaPlayout = {
    audioCtx: null,
    nextPlayTime: 0,
    decoder: null,
    canvas: null,
    c2d: null,
    audioFrames: 0,
    videoAus: 0,
    ensureAudioCtx(){
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        this.nextPlayTime = 0;
      }
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      return this.audioCtx;
    },
    playPcm(int16){
      CalleeAudioBus.push(int16); // no-op unless an avatar call is listening
      try {
        const ctx = this.ensureAudioCtx();
        const f32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000;
        const buf = ctx.createBuffer(1, f32.length, 16000);
        buf.copyToChannel(f32, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        // Schedule back-to-back with a small lead so gaps between WS frames
        // don't turn into clicks; re-sync if we fall behind the clock.
        const now = ctx.currentTime;
        if (this.nextPlayTime < now) this.nextPlayTime = now + 0.06;
        src.start(this.nextPlayTime);
        this.nextPlayTime += buf.duration;
        this.audioFrames++;
      } catch(e) { /* no audio device / autoplay blocked - not worth killing a call */ }
    },
    pipStream: null,
    // Routes the decoded peer camera into #socialSelfVideo (the PIP/split
    // slot) by capturing the decode canvas as a MediaStream. That makes the
    // callee a normal <video> in the layout the user already has - PIP, split,
    // tap-to-swap and drag all keep working untouched - instead of a separate
    // overlay. Falls back to the old overlay canvas if captureStream is missing.
    attachToPip(){
      if (this.pipStream) return true;
      const canvas = this.canvas || $('socialPeerCanvas');
      const sv = $('socialSelfVideo');
      if (!canvas || !sv || typeof canvas.captureStream !== 'function') return false;
      try {
        this.pipStream = canvas.captureStream(15);
        sv.srcObject = this.pipStream;
        sv.dataset.feed = 'peer'; // CSS un-mirrors it (the self-view mirror is for cameras)
        sv.style.display = ''; // shown only now that there is a picture to show
        const p = sv.play && sv.play(); if (p && p.catch) p.catch(() => {});
        // Keep the canvas in the DOM (some browsers stop capturing a
        // display:none canvas) but invisible: the <video> is what is shown.
        canvas.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
        return true;
      } catch(e) {
        console.warn('[PeerMedia] could not route the peer video into the PIP:', e.message);
        this.pipStream = null;
        return false;
      }
    },
    ensureDecoder(){
      if (this.decoder) return this.decoder;
      if (typeof window.VideoDecoder === 'undefined') return null;
      this.canvas = $('socialPeerCanvas');
      if (!this.canvas) return null;
      this.c2d = this.canvas.getContext('2d');
      this.attachToPip();
      try {
        this.decoder = new window.VideoDecoder({
          output: (frame) => {
            try {
              // WhatsApp sends the camera sensor orientation (CVO) with every
              // frame: a phone held upright arrives turned 90/270 degrees and
              // the receiver has to rotate it back. Without this the callee
              // showed up sideways.
              const rot = this.peerRotation || 0;
              const fw = frame.displayWidth, fh = frame.displayHeight;
              const swap = rot === 90 || rot === 270;
              const cw = swap ? fh : fw, ch = swap ? fw : fh;
              if (this.canvas.width !== cw || this.canvas.height !== ch) {
                this.canvas.width = cw;
                this.canvas.height = ch;
              }
              this.c2d.save();
              this.c2d.translate(cw / 2, ch / 2);
              this.c2d.rotate((-rot * Math.PI) / 180);
              this.c2d.drawImage(frame, -fw / 2, -fh / 2, fw, fh);
              this.c2d.restore();
              if (!this.pipStream) this.canvas.style.display = 'block'; // legacy overlay fallback
            } catch(e) {}
            try { frame.close(); } catch(e) {}
          },
          error: () => { this.decoder = null; },
        });
        // H.264 Constrained Baseline - the profile WhatsApp calls use, and
        // the one the Rust bridge's encoder is configured for.
        this.decoder.configure({ codec: 'avc1.42E01F', optimizeForLatency: true });
      } catch(e) {
        this.decoder = null;
      }
      return this.decoder;
    },
    // `wire` (optional) carries what the transport already knows about the
    // access unit: WaCalls' "vp8" frames state whether they are keyframes and
    // carry their own microsecond timestamp, which is more reliable than
    // re-scanning the bitstream - and a decoder that only ever sees "delta"
    // frames never produces a picture. Falls back to the annex-B scan when no
    // framing information is available (the 0x04 media-socket channel).
    pushH264(bytes, wire){
      this.videoAus++;
      if (wire && typeof wire.rotationDeg === 'number') this.peerRotation = wire.rotationDeg;
      const dec = this.ensureDecoder();
      if (!dec || dec.state !== 'configured') return;
      const isKey = wire && typeof wire.keyframe === 'boolean'
        ? wire.keyframe
        : annexBHasKeyframe(bytes);
      const ts = wire && wire.timestampMs
        ? Math.round(wire.timestampMs * 1000)
        : Math.round(performance.now() * 1000);
      try {
        dec.decode(new window.EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: ts,
          data: bytes,
        }));
      } catch(e) {}
    },
    stop(){
      this.peerRotation = 0;
      if (this.decoder) { try { this.decoder.close(); } catch(e){} this.decoder = null; }
      if (this.audioCtx) { try { this.audioCtx.close(); } catch(e){} this.audioCtx = null; }
      this.nextPlayTime = 0;
      this.audioFrames = 0;
      this.videoAus = 0;
      const canvas = $('socialPeerCanvas');
      if (canvas) canvas.style.display = 'none';
      if (this.pipStream) {
        try { this.pipStream.getTracks().forEach(t => t.stop()); } catch(e){}
        this.pipStream = null;
        const sv = $('socialSelfVideo');
        if (sv) { sv.srcObject = null; delete sv.dataset.feed; }
      }
    },
  };


  // =============================================================================
  // WaCallsMediaLeg - the browser half of a WaCalls call's media plane.
  //
  // WaCalls carries call media over WebRTC data channels between this page and
  // the WaCalls server (its cmd/server/bridge.go):
  //
  //   "pcm"  raw 16 kHz mono s16le, BOTH directions, unframed.
  //            up   - the outgoing call audio: the microphone, or the
  //                   RVC-converted voice when conversion is on (same audio the
  //                   Green API path puts on its outgoing WebRTC track)
  //            down - the peer's voice -> PeerMediaPlayout.playPcm
  //   "vp8"  encoded H.264 access units, BOTH directions, 5-byte header:
  //            1 flags byte (bit0 = keyframe, bits1-2 = rotation) + uint32 BE
  //            timestamp in ms. A 1-byte message is a control frame from the
  //            server asking for an immediate keyframe (peer's RTCP PLI/FIR).
  //            up   - the live avatar, encoded here with WebCodecs (the Go side
  //                   only packetizes; the codec lives in this page)
  //            down - the peer's camera -> PeerMediaPlayout's decoder -> canvas
  //
  // Handshake: this page builds the SDP offer, posts it to OUR server
  // (/api/social-call/wacalls/webrtc), and our server relays it to WaCalls with
  // the API key. The media itself then flows directly between this page and
  // the WaCalls instance - never through this app's server, and the key never
  // reaches the page.
  //
  // Outgoing video source: `avatarSource()`, i.e. the same activeSocialSource()
  // the prep screen and every other call path use. Anam and Lucy 2.5 are
  // therefore interchangeable here, and switching mid-call is only a matter of
  // reading the other element from the next frame on (setAvatarSource()).
  // =============================================================================
  const WaCallsMediaLeg = {
    pc: null,
    pcmDC: null,
    videoDC: null,
    callId: null,
    active: false,
    muted: false,
    voiceConversion: false,
    source: 'lucy',
    video: false,
    micCtx: null,
    micSource: null,
    micNode: null,
    outStream: null, // the avatar's voice, when it is the outgoing audio (avatar mode)
    canvas: null,
    ctx: null,
    encoder: null,
    encoderError: null,
    encodeTimer: null,
    forceKeyframe: true,
    kfTimers: [],
    // The callee's phone shows a spinner until it gets a keyframe it can decode. Ask for one right
    // away when the call connects and again over the next seconds, instead of leaving it to the 2s cycle.
    keyframeBurst(){
      (this.kfTimers || []).forEach(clearTimeout); this.kfTimers = [];
      [0, 700, 1800, 3500].forEach((ms) => this.kfTimers.push(setTimeout(() => { this.forceKeyframe = true; }, ms)));
    },
    lastKeyframeAt: 0,
    // Counters, surfaced in the logs so "connected but nothing on screen" is
    // diagnosable without a debugger (same habit as the rest of this call code).
    sent: { audioFrames: 0, videoFrames: 0, keyframeRequests: 0 },
    received: { audioFrames: 0, videoFrames: 0 },

    supported(){
      return typeof window.VideoEncoder !== 'undefined' && typeof window.VideoFrame !== 'undefined';
    },
    supportedDetail(){
      if (this.supported()) return 'WebCodecs available - avatar video can be sent';
      return 'this browser has no WebCodecs (VideoEncoder), so the avatar cannot be encoded for the call';
    },

    avatarSource(){
      return this.source === 'anam' ? SocialAnamSource : LiveSwapMediaSource;
    },

    // Called from the call screen (and by the prep screen, so both agree).
    // Returns true when the switch took effect for the outgoing video.
    setAvatarSource(source){
      const next = source === 'anam' ? 'anam' : 'lucy';
      const changed = next !== this.source;
      this.source = next;
      // The new source must already be producing frames; if it is not running
      // yet (switching before the call, or after it was stopped), start it now.
      const src = this.avatarSource();
      if (this.active && src && !src.isActive()) {
        src.start({ forSocialCall: true }).catch((e) => {
          console.warn('[WaCalls] could not start the new avatar source:', e.message);
        });
      }
      if (changed) {
        this.forceKeyframe = true; // the new source's first frame must be a keyframe
        console.log(`[WaCalls] avatar video source -> ${next === 'anam' ? 'Anam' : 'Lucy 2.5'} (callId=${this.callId || 'none'})`);
      }
      return changed;
    },

    setMuted(muted){
      this.muted = !!muted;
      console.log(`[WaCalls] microphone ${this.muted ? 'muted' : 'unmuted'} (callId=${this.callId || 'none'})`);
    },

    setVoiceConversion(on){
      this.voiceConversion = !!on;
      // With conversion on, the outgoing audio is the converted stream that
      // arrives over the media socket (0x06 -> VoiceConversionPlayout.onConverted
      // -> the sink installed below). Without it, the microphone goes straight
      // out, exactly as before.
      VoiceConversionPlayout.sink = this.voiceConversion
        ? (int16) => this.sendConvertedAudio(int16)
        : null;
    },

    sendConvertedAudio(int16){
      if (!this.active || !this.pcmDC || this.pcmDC.readyState !== 'open' || !int16 || !int16.length) return;
      this.pcmSend(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength));
    },

    pcmSend(bytes){
      try { this.pcmDC.send(bytes); this.sent.audioFrames++; } catch (e) {}
    },

    // Avatar mode: the call audio is the avatar's own voice, not a microphone.
    // Can be attached before or after the leg is open (the avatar is started
    // when the callee answers, which may be before or after negotiation ends).
    attachOutgoingAudio(stream){
      this.outStream = stream || null;
      if (this.active && stream) this.startAudio(false, stream);
    },

    // Digital silence at 16 kHz, 20 ms at a time, until the avatar's voice is
    // attached (see encodeFrame for why something must flow from the start).
    silenceTimer: null,
    startSilence(){
      if (this.silenceTimer) return;
      const frame = new Uint8Array(320 * 2); // 320 samples of 16-bit zero
      this.silenceTimer = setInterval(() => {
        if (!this.active || !this.pcmDC || this.pcmDC.readyState !== 'open') return;
        this.pcmSend(frame);
      }, 20);
    },
    stopSilence(){
      if (this.silenceTimer) { clearInterval(this.silenceTimer); this.silenceTimer = null; }
    },

    async open({ callId, video = true, source = 'lucy', voiceConversion = false } = {}){
      const keepOut = this.outStream;
      if (this.active) this.close();
      this.outStream = keepOut;
      this.callId = callId;
      this.video = !!video;
      this.source = source === 'anam' ? 'anam' : 'lucy';
      this.active = true;
      this.sent = { audioFrames: 0, videoFrames: 0, keyframeRequests: 0 };
      this.received = { audioFrames: 0, videoFrames: 0 };
      console.log(`[WaCalls] opening media leg for callId=${callId} (video=${this.video}, avatar=${this.source}, voiceConversion=${voiceConversion})`);

      try {
        // A public STUN server lets the browser publish its public (server-
        // reflexive) address; with an empty list a phone on cellular/NAT only
        // offers private host candidates that WaCalls cannot reach.
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        this.pc = pc;

        // --- data channels (must exist before the offer) -------------------
        const pcmDC = pc.createDataChannel('pcm', { ordered: true });
        pcmDC.binaryType = 'arraybuffer';
        pcmDC.onmessage = (e) => this.onPcmMessage(e.data);
        this.pcmDC = pcmDC;

        if (this.video) {
          // Video must not be sent reliably and in order: on a phone connection one lost packet then holds
          // every later frame back (reliable delivery waits for the resend), latency builds up (the callee's lag) and the picture finally stalls on a
          // spinner. Frames stay in order but a frame older than 200ms is dropped instead of resent.
          const videoDC = pc.createDataChannel('vp8', { ordered: true, maxPacketLifeTime: 200 });
          videoDC.binaryType = 'arraybuffer';
          videoDC.onmessage = (e) => this.onVideoMessage(e.data);
          this.videoDC = videoDC;
        }

        pc.oniceconnectionstatechange = () => {
          if (!this.active) return;
          const st = pc.iceConnectionState;
          console.log(`[WaCalls] media ICE state: ${st} (callId=${this.callId})`);
          trace('media link: ' + st);
          if (st === 'failed') {
            console.error(`[WaCalls] media connection FAILED for callId=${this.callId}`);
            showCallFailureAndEnd('Call media connection lost');
          }
        };

        if (this.source === 'anam') {
          // No microphone in avatar mode: wait for the avatar's own voice.
          if (this.outStream) this.startAudio(false, this.outStream);
          else this.startSilence(); // replaced by the avatar's voice once it is attached
        } else {
          this.startAudio(voiceConversion);
        }
        if (this.video) this.startVideo();

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Wait for ICE gathering, but never indefinitely: 2.5 s is plenty for
        // host + STUN candidates and the offer goes out with whatever exists.
        await new Promise((resolve) => {
          if (pc.iceGatheringState === 'complete') return resolve();
          const t = setTimeout(resolve, 2500);
          pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
          });
        });

        const relayCtl = new AbortController();
        const relayTimer = setTimeout(() => relayCtl.abort(), 20000);
        let res;
        try {
          res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/webrtc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callId, sdp_offer: pc.localDescription.sdp }),
            signal: relayCtl.signal,
          });
        } catch (e) {
          throw new Error(e.name === 'AbortError' ? 'WaCalls did not answer the media offer within 20s' : e.message);
        } finally { clearTimeout(relayTimer); }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.sdp_answer) {
          throw new Error(data.error || `WaCalls refused the media offer (HTTP ${res.status})`);
        }
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp_answer });
        console.log(`[WaCalls] media leg negotiated for callId=${callId} (pcm${this.video ? ' + vp8' : ''} channels)`);
      } catch (e) {
        console.error(`[WaCalls] media leg failed for callId=${callId}: ${e.message}`);
        this.close();
        throw e;
      }
    },

    // --- audio -----------------------------------------------------------
    startAudio(voiceConversion, overrideStream){
      this.setVoiceConversion(voiceConversion);
      // Replace any previous capture graph (the avatar's voice can arrive after
      // an earlier attach attempt).
      if (this.micNode) { try { this.micNode.disconnect(); } catch (e) {} this.micNode = null; }
      if (this.micSource) { try { this.micSource.disconnect(); } catch (e) {} this.micSource = null; }
      if (this.micCtx) { try { this.micCtx.close(); } catch (e) {} this.micCtx = null; }
      const stream = overrideStream || (voiceConversion ? outgoingCallAudioStream() : socialMicStream);
      if (!stream || !stream.getAudioTracks().length) {
        console.warn('[WaCalls] no microphone stream available for the call audio');
        return;
      }
      this.stopSilence();
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.micCtx = new AudioCtx({ sampleRate: 16000 });
        if (this.micCtx.state === 'suspended') this.micCtx.resume().catch(() => {});
        this.micSource = this.micCtx.createMediaStreamSource(stream);
        // 512-sample buffers while converting (the converter is fed one chunk
        // per round trip, so a bigger buffer would add its whole length in
        // latency); the original 2048 otherwise. Same trade-off as the Green
        // API/Telegram adapter above.
        const bufferSize = voiceConversion ? 512 : 2048;
        this.micNode = this.micCtx.createScriptProcessor(bufferSize, 1, 1);
        this.micNode.onaudioprocess = (evt) => {
          if (!this.active) return;
          // With conversion on, the converted audio is what goes out (see
          // setVoiceConversion / sendConvertedAudio); the raw mic is only the
          // converter's input, which the media socket already carries.
          if (this.voiceConversion) return;
          if (!this.pcmDC || this.pcmDC.readyState !== 'open') return;
          const input = evt.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const v = Math.max(-1, Math.min(1, input[i]));
            // Muted = digital silence rather than no packets at all: the peer's
            // stream keeps flowing, and nothing of the room goes out.
            pcm16[i] = this.muted ? 0 : (v < 0 ? v * 0x8000 : v * 0x7FFF);
          }
          this.pcmSend(new Uint8Array(pcm16.buffer));
        };
        this.micSource.connect(this.micNode);
        // Reaching the destination keeps Safari's ScriptProcessor alive. The
        // handler never writes to outputBuffer, so this plays SILENCE - it is
        // not a local monitor of the microphone.
        this.micNode.connect(this.micCtx.destination);
      } catch (e) {
        console.warn('[WaCalls] could not start call audio capture:', e.message);
      }
    },

    onPcmMessage(data){
      try {
        const copy = data instanceof ArrayBuffer ? new Uint8Array(data).slice() : null;
        if (!copy) return;
        const samples = new Int16Array(copy.buffer, 0, Math.floor(copy.length / 2));
        this.received.audioFrames++;
        PeerMediaPlayout.playPcm(samples);
      } catch (e) {}
    },

    // --- video (out) -----------------------------------------------------
    startVideo(){
      if (!this.supported()) {
        // Honest failure: say it on the call screen instead of sending a call
        // that looks like video and never shows anything.
        this.encoderError = this.supportedDetail();
        console.error(`[WaCalls] ${this.encoderError}`);
        const lbl = $('socialCallStatusLabel');
        if (lbl) lbl.textContent = 'Audio-only (browser has no WebCodecs)';
        return;
      }
      this.canvas = document.createElement('canvas');
      // 480x640 is the size the call server (server/wacalls.md) and WhatsApp are known to accept. A taller
      // frame (352x768) left the callee on a loading spinner, so the picture is cropped to fill THIS frame.
      this.canvas.width = 480;
      this.canvas.height = 640;
      this.ctx = this.canvas.getContext('2d');

      let encodeErrors = 0;
      this.encoder = new window.VideoEncoder({
        output: (chunk, meta) => this.sendEncoded(chunk, meta),
        error: (e) => {
          encodeErrors++;
          this.encoderError = e.message || String(e);
          if (encodeErrors <= 3) console.error('[WaCalls] video encoder error:', e.message || e);
        },
      });
      // Constrained Baseline / 3.1, annex-B: the profile WhatsApp video calls
      // use, and the one WaCalls' bridge hands to its own RTP packetizer.
      this.encoder.configure({
        codec: 'avc1.42E01F',
        avc: { format: 'annexb' },
        latencyMode: 'realtime',
        width: this.canvas.width,
        height: this.canvas.height,
        bitrate: 600_000,
        framerate: 15,
      });

      clearInterval(this.encodeTimer);
      // 15 fps matches the rest of this app's social-call video (Telegram and
      // the previous WhatsApp engine both use 15 fps for the avatar stream).
      this.encodeTimer = setInterval(() => this.encodeFrame(), 1000 / 15);
    },

    encodeFrame(){
      if (!this.active || !this.encoder || this.encoder.state !== 'configured') return;
      if (!this.videoDC || this.videoDC.readyState !== 'open') return;
      // Never let frames queue up: a backed-up send buffer or encoder is what makes the callee's
      // video lag further and further behind. Drop this frame and send the next fresh one instead.
      if (this.videoDC.bufferedAmount > 128 * 1024) return;
      if (this.encoder.encodeQueueSize > 2) return;
      let vid = this.avatarSource().getVideoElement() || $('socialRemoteVideo');
      if (this.source === 'anam') {
        // The avatar's own element sits on the prep screen, which is hidden once the call
        // screen opens, and a hidden <video> can hand canvas.drawImage() black frames (the
        // callee saw a blank screen while the avatar was clearly visible on this phone).
        // The call screen's own element shows the same stream and is on screen, so read
        // the picture from that one whenever it is playing.
        const live = $('socialRemoteVideo');
        if (live && live.srcObject && live.videoWidth > 0) {
          if (live.paused) { try { live.play().catch(() => {}); } catch (e) {} }
          vid = live;
        }
      }
      const avatarLive = !!(vid && (vid.videoWidth || vid.readyState >= 2));
      if (!avatarLive) {
        // The avatar takes several seconds to start (it only starts once the
        // callee answers). Until it produces frames, send a plain dark frame so
        // the callee's phone gets video immediately; with nothing arriving,
        // WhatsApp can sit on "connecting" and then drop the call.
        try {
          this.ctx.fillStyle = '#101010';
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        } catch (e) { return; }
      } else {
        try {
          drawCover(this.ctx, vid, this.canvas.width, this.canvas.height);
        } catch (e) {
          return; // frame not decoded yet / cross-origin - try the next tick
        }
        // Every ~2s check the frame we are about to send is not just black, and say so
        // in the call timeline if it is - "the callee sees blank" becomes visible here.
        this.frameCount = (this.frameCount || 0) + 1;
        if (this.frameCount === 1) trace('video: first avatar frame sent (' + (vid.id || 'avatar element') + ' ' + vid.videoWidth + 'x' + vid.videoHeight + ')');
        if (this.frameCount % 30 === 0) {
          try {
            const w = this.canvas.width, h = this.canvas.height;
            const d = this.ctx.getImageData(Math.floor(w / 2) - 8, Math.floor(h / 2) - 8, 16, 16).data;
            let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
            const dark = (sum / (d.length / 4) / 3) < 10;
            if (dark) { this.darkRuns = (this.darkRuns || 0) + 1; if (this.darkRuns === 2) trace('video: avatar frames are BLACK (callee will see blank)'); }
            else { if (this.darkRuns >= 2) trace('video: avatar frames are visible again'); this.darkRuns = 0; }
          } catch (e) {}
        }
      }
      const ts = Math.round(performance.now() * 1000); // microseconds
      let frame;
      try {
        frame = new window.VideoFrame(this.canvas, { timestamp: ts });
      } catch (e) {
        return;
      }
      // Keyframe on the first frame and every 2s, plus whenever the server
      // forwards a PLI/FIR from the peer or the avatar source was switched
      // (a decoder that joins mid-stream cannot start on a delta frame).
      const wantKey = this.forceKeyframe || (ts - this.lastKeyframeAt) > 2_000_000;
      try {
        this.encoder.encode(frame, { keyFrame: wantKey });
      } catch (e) {}
      if (wantKey) {
        this.forceKeyframe = false;
        this.lastKeyframeAt = ts;
      }
      try { frame.close(); } catch (e) {}
    },

    sendEncoded(chunk, meta){
      if (!this.videoDC || this.videoDC.readyState !== 'open') return;
      try {
        let payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        // The call server hands these bytes straight to an RTP packetizer that only understands Annex-B.
        // Some browsers (Safari has been inconsistent about avc.format) hand back length-prefixed AVCC
        // instead; unconverted, the callee's phone just sits on "loading". Convert, and check keyframes.
        try {
          const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
          if (desc) this.avcDesc = new Uint8Array(desc.buffer ? desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength) : desc);
        } catch (_) {}
        const fmt = h264Format(payload);
        if (fmt !== 'annexb') {
          const conv = avccToAnnexB(payload, this.avcDesc, chunk.type === 'key');
          if (!this.fmtTraced) { this.fmtTraced = true; trace('video: encoder output is ' + (fmt === 'avcc' ? 'AVCC - converting to Annex-B' : 'UNKNOWN format - converting') + (this.avcDesc ? '' : ' (no decoder config)')); }
          if (!conv) { if (!this.badFrames) { this.badFrames = 1; trace('video: could not convert an encoder frame - dropped'); } return; }
          payload = conv;
        } else if (chunk.type === 'key' && this.avcDesc && !h264HasParamSets(payload)) {
          payload = prependParamSets(payload, this.avcDesc);
          if (!this.fmtTraced) { this.fmtTraced = true; trace('video: keyframes lacked SPS/PPS - added'); }
        } else if (!this.fmtTraced) { this.fmtTraced = true; trace('video: encoder output is Annex-B (ok)'); }
        const out = new Uint8Array(5 + payload.byteLength);
        // bit0 = keyframe, bits1-2 = rotation (0 - the avatar canvas is not
        // rotated), then a uint32 BE timestamp in ms, then the H.264 Annex-B
        // access unit. Byte-for-byte the format WaCalls' media.VideoFrame
        // expects from the browser on the "vp8" channel.
        out[0] = (chunk.type === 'key' ? 1 : 0);
        const tsMs = Math.round(chunk.timestamp / 1000) >>> 0;
        out[1] = (tsMs >>> 24) & 0xff;
        out[2] = (tsMs >>> 16) & 0xff;
        out[3] = (tsMs >>> 8) & 0xff;
        out[4] = tsMs & 0xff;
        out.set(payload, 5);
        this.videoDC.send(out);
        this.sent.videoFrames++;
        if (this.sent.videoFrames === 1) console.log(`[WaCalls] first avatar frame sent on the vp8 channel (callId=${this.callId})`);
      } catch (e) {}
    },

    // --- video (in) ------------------------------------------------------
    onVideoMessage(data){
      const bytes = new Uint8Array(data);
      // 1-byte control frame: the server relays the peer's keyframe request.
      if (bytes.length === 1 && bytes[0] === 0x01) {
        this.forceKeyframe = true;
        this.sent.keyframeRequests++;
        return;
      }
      if (bytes.length < 6) return;
      const flags = bytes[0];
      const tsMs = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
      this.received.videoFrames++;
      // bits 1-2 of the flags byte = rotation: 0, 90, 180 or 270 degrees.
      PeerMediaPlayout.pushH264(bytes.subarray(5), { keyframe: (flags & 1) !== 0, timestampMs: tsMs, rotationDeg: ((flags >> 1) & 3) * 90 });
      if (this.received.videoFrames === 1) console.log(`[WaCalls] first peer video frame decoded (callId=${this.callId})`);
    },

    close(){
      const wasActive = this.active;
      const sent = { ...this.sent };
      const received = { ...this.received };
      this.active = false;
      (this.kfTimers || []).forEach(clearTimeout); this.kfTimers = [];
      this.frameCount = 0; this.darkRuns = 0; this.fmtTraced = false; this.badFrames = 0; this.avcDesc = null;
      this.stopSilence();
      clearInterval(this.encodeTimer);
      this.encodeTimer = null;
      if (this.encoder) { try { this.encoder.close(); } catch (e) {} this.encoder = null; }
      this.forceKeyframe = true;
      this.lastKeyframeAt = 0;
      this.setVoiceConversion(false);
      if (this.micNode) { try { this.micNode.disconnect(); } catch (e) {} this.micNode = null; }
      if (this.micSource) { try { this.micSource.disconnect(); } catch (e) {} this.micSource = null; }
      if (this.micCtx) { try { this.micCtx.close(); } catch (e) {} this.micCtx = null; }
      if (this.pcmDC) { try { this.pcmDC.close(); } catch (e) {} this.pcmDC = null; }
      if (this.videoDC) { try { this.videoDC.close(); } catch (e) {} this.videoDC = null; }
      if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; }
      this.outStream = null;
      PeerMediaPlayout.stop();
      if (wasActive) {
        console.log(`[WaCalls] media leg closed for callId=${this.callId} (sent ${sent.audioFrames} audio / ${sent.videoFrames} video frames, keyframe requests ${sent.keyframeRequests}, received ${received.audioFrames} audio / ${received.videoFrames} video)`);
      }
      this.callId = null;
    },

    // Re-negotiates the same peer connection to add the "vp8" channel on a
    // call that started as audio only, then tells WaCalls to signal the video
    // upgrade to WhatsApp (POST .../video/start). Unused by the normal flow -
    // video calls start with video - but it is the documented WaCalls path for
    // a mid-call upgrade, and this is where the app would call it from.
    async upgradeToVideo(){
      if (!this.active || this.video) return;
      if (!this.supported()) throw new Error(this.supportedDetail());
      this.video = true;
      const videoDC = this.pc.createDataChannel('vp8', { ordered: true, maxPacketLifeTime: 200 });
      videoDC.binaryType = 'arraybuffer';
      videoDC.onmessage = (e) => this.onVideoMessage(e.data);
      this.videoDC = videoDC;
      this.startVideo();
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await new Promise((resolve) => {
        if (this.pc.iceGatheringState === 'complete') return resolve();
        this.pc.addEventListener('icegatheringstatechange', () => {
          if (this.pc.iceGatheringState === 'complete') resolve();
        });
      });
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/webrtc/renegotiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: this.callId, sdp_offer: this.pc.localDescription.sdp }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.sdp_answer) throw new Error(data.error || `renegotiate failed (HTTP ${res.status})`);
      await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp_answer });
      await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/video/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: this.callId }),
      }).catch(() => {});
      console.log(`[WaCalls] upgraded callId=${this.callId} to video`);
    },
  };

    // Annex-B start-code scan for an IDR/SPS NAL, so the decoder is told which
  // access units are safe to start from.
  function annexBHasKeyframe(bytes){
    const v = new Uint8Array(bytes);
    for (let i = 0; i + 4 < v.length; i++) {
      const is4 = v[i] === 0 && v[i+1] === 0 && v[i+2] === 0 && v[i+3] === 1;
      const is3 = !is4 && v[i] === 0 && v[i+1] === 0 && v[i+2] === 1;
      if (!is4 && !is3) continue;
      const nalType = v[i + (is4 ? 4 : 3)] & 0x1f;
      if (nalType === 5 || nalType === 7) return true; // IDR slice, or SPS
    }
    return false;
  }

  // Peer media frames arriving over the media socket (0x03 PCM, 0x04 H.264),
  // and this call's own outgoing audio after RVC conversion (0x06 - see
  // broadcastConvertedAudio in server.mjs). WaCalls' peer media does NOT come
  // through here: it arrives on this page's own data channels (see
  // WaCallsMediaLeg), which use PeerMediaPlayout directly. One channel-tagged,
  // length-prefixed frame format for this socket, so it has one binary parser.
  function handleMediaWsBinary(data){
    const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer || data);
    if (bytes.length < 5) return;
    const channel = bytes[0];
    const len = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
    if (bytes.length < 5 + len) return;
    const payload = bytes.subarray(5, 5 + len);

    if (channel === 0x03) {
      // Peer PCM: s16le mono @ 16 kHz. `payload` is a view at an ODD byte
      // offset (the 5-byte frame header), and Int16Array requires an even
      // one, so copy into a fresh buffer rather than aliasing.
      const copy = payload.slice();
      const samples = new Int16Array(copy.buffer, 0, Math.floor(copy.length / 2));
      PeerMediaPlayout.playPcm(samples);
    } else if (channel === 0x04) {
      // Peer H.264 access unit (Annex-B).
      PeerMediaPlayout.pushH264(payload.slice().buffer);
    } else if (channel === 0x06) {
      // This call's own outgoing audio, after RVC conversion - s16le mono.
      const copy = payload.slice();
      const samples = new Int16Array(copy.buffer, 0, Math.floor(copy.length / 2));
      VoiceConversionPlayout.onConverted(samples);
    }
  }

  // Social Call Media Adapter
  // Pipes real-time Lucy 2.5 Live Swap video frames and mic audio to social call bridge
  const SocialCallMediaAdapter = {
    ws: null,
    frameTimer: null,
    audioProcessor: null,
    micAudioCtx: null,
    active: false,
    watching: false,
    voiceConversion: false,
    initWs(){
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      this.ws = new WebSocket(SOCIAL_CALL_API_BASE.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/api/social-call/media?token=' + encodeURIComponent(socialAccessToken || ''));
      this.ws.binaryType = 'arraybuffer';
      this.ws.onmessage = (e) => {
        // Binary frames are tagged, length-prefixed frames (see
        // handleMediaWsBinary): 0x03 = peer PCM audio, 0x04 = peer H.264
        // access unit (peer media returned over this socket),
        // 0x06 = this call's own outgoing audio after RVC conversion. Text
        // frames are the JSON control/call_state messages as before.
        if (typeof e.data !== 'string') {
          handleMediaWsBinary(e.data);
          return;
        }
        try {
          const msg = JSON.parse(e.data);
          handleMediaWsMessage(msg);
        } catch(err){}
      };
      this.ws.onclose = () => {
        if (this.active || this.watching) setTimeout(() => this.initWs(), 2000);
      };
    },
    // Keeps the socket open even when no call is streaming. WaCalls delivers
    // incoming calls as events on this socket, and there is no client SDK
    // relaying them the way Green API has: a socket that only opens once a
    // call starts would never see a call arrive. Enabled when the WaCalls
    // engine reports a paired session (see fetchWaCallsStatus).
    watchEvents(on){
      this.watching = !!on;
      if (this.watching) this.initWs();
      else if (!this.active) { try { this.ws?.close(); } catch (e) {} this.ws = null; }
    },
    // JSON control channel on the same socket (start/stop conversion, status).
    sendControl(msg){
      this.initWs();
      const ws = this.ws;
      if (!ws) return;
      const send = () => { try { ws.send(JSON.stringify(msg)); } catch (e) {} };
      if (ws.readyState === WebSocket.OPEN) send();
      else ws.addEventListener('open', send, { once: true });
    },
    startStreaming(stream, micStream, options = {}){
      const voiceConversion = !!options.voiceConversion;
      // WaCalls carries its own call media (see WaCallsMediaLeg): the avatar
      // video goes out on WaCalls' data channel, not as 0x01 JPEG frames, and
      // the call audio is this page's own "pcm" channel. This socket then has
      // two jobs left for a WaCalls call: the event stream (call_state,
      // wacalls_event) and the RVC round trip - raw mic up as 0x02, converted
      // audio back as 0x06 (which the leg's sink puts on the call). So: no
      // 0x01 video loop, and 0x02 always carries the RAW microphone (the
      // converted audio must never be fed back into the converter).
      const waCallsLeg = !!options.waCalls;
      this.voiceConversion = voiceConversion;
      this.active = true;
      this.initWs();

      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 640;
      const ctx = canvas.getContext('2d');
      const vid = activeSocialSource().getVideoElement() || $('socialRemoteVideo');

      clearInterval(this.frameTimer);
      if (waCallsLeg) this.frameTimer = null;
      else
      // 15 fps loop matching WhatsApp and PyTgCalls video specification
      this.frameTimer = setInterval(() => {
        if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (vid && (vid.videoWidth || vid.readyState >= 2)) {
          drawCover(ctx, vid, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            if (!blob || !this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            blob.arrayBuffer().then((buf) => {
              const tagged = new Uint8Array(buf.byteLength + 1);
              tagged[0] = 0x01; // 0x01 = Lucy 2.5 Video Frame
              tagged.set(new Uint8Array(buf), 1);
              this.ws.send(tagged);
            });
          }, 'image/jpeg', 0.7);
        }
      }, 1000 / 15);

      // Live outgoing call audio, PCM 16kHz mono.
      //
      // This is the audio that travels out with the Lucy 2.5 video, so it is
      // the stream the realtime RVC conversion is fed from. The chunk size is
      // smaller while converting: the converter is fed one chunk per round
      // trip, so the original 2048-sample buffer (128ms at 16kHz) would add
      // that much latency before conversion even starts. With conversion off
      // the original buffer size is kept exactly as it was.
      const audioStream = voiceConversion && !waCallsLeg ? outgoingCallAudioStream() : micStream;
      if (audioStream && audioStream.getAudioTracks().length) {
        try {
          const bufferSize = voiceConversion ? 512 : 2048;
          this.micAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
          const source = this.micAudioCtx.createMediaStreamSource(audioStream);
          this.audioProcessor = this.micAudioCtx.createScriptProcessor(bufferSize, 1, 1);
          this.audioProcessor.onaudioprocess = (evt) => {
            if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const input = evt.inputBuffer.getChannelData(0);
            const pcm16 = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) {
              const s = Math.max(-1, Math.min(1, input[i]));
              pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            const tagged = new Uint8Array(pcm16.buffer.byteLength + 1);
            // 0x02 = live outgoing call audio (the audio that goes out with
            // the Lucy 2.5 video). When conversion is running, the server
            // routes this through RVC instead of sending it to the call.
            tagged[0] = 0x02;
            tagged.set(new Uint8Array(pcm16.buffer), 1);
            this.ws.send(tagged);
          };
          source.connect(this.audioProcessor);
          this.audioProcessor.connect(this.micAudioCtx.destination);
        } catch(e){}
      }
    },
    stop(){
      this.active = false;
      clearInterval(this.frameTimer);
      if (this.audioProcessor) { try { this.audioProcessor.disconnect(); } catch(e){} this.audioProcessor = null; }
      if (this.micAudioCtx) { try { this.micAudioCtx.close(); } catch(e){} this.micAudioCtx = null; }
      if (this.ws) { try { this.ws.close(); } catch(e){} this.ws = null; }
    }
  };

  // Shows why a call failed on whatever screen the person can actually see
  // right now, then hangs up. Call failures resolve asynchronously (the
  // backend bridge places the real call in the background), by which point
  // placeSocialCall() has already hidden the Call Preparation modal and
  // shown the active call screen - writing the reason into the modal's
  // (now invisible) prepErrorHint and hanging up immediately, as this used
  // to do, meant every failure looked like a silent crash back to Home with
  // no explanation anywhere.
  // Why the last call ended (set by whatever ended it), shown as a toast once the
  // call screen has closed - the on-screen label used to vanish with the screen.
  let lastEndReason = '', lastRemoteEndReason = '';
  // ---- avatar speech gate (outgoing WhatsApp avatar calls) -------------------------------
  // The avatar starts BEFORE the phone rings so it is ready, but it must say nothing until the call
  // is really connected + 5 seconds, and it must be told when that happens. Until then its input is
  // muted (so it cannot hear noise and react) and it has been told to stay silent.
  let avatarGateActive = false, avatarGreeted = false, callConnectedAt = 0, avatarReadyForGreeting = false, greetTimer = null;
  const GREETING_DELAY_MS = 5000;
  function resetAvatarGate(on){
    clearTimeout(greetTimer); greetTimer = null;
    avatarGateActive = !!on; avatarGreeted = false; callConnectedAt = 0; avatarReadyForGreeting = false;
  }
  function scheduleAvatarGreeting(){
    if (!avatarGateActive || avatarGreeted || !callConnectedAt || !avatarReadyForGreeting || greetTimer) return;
    const wait = Math.max(0, callConnectedAt + GREETING_DELAY_MS - Date.now());
    greetTimer = setTimeout(() => {
      greetTimer = null;
      if (!avatarGateActive || avatarGreeted) return;
      avatarGreeted = true;
      SocialAnamSource.notifyCallConnected((selectedSocialContact && selectedSocialContact.name) || '');
      trace('avatar: call connected + ' + (GREETING_DELAY_MS / 1000) + 's - listening and told it');
    }, wait);
  }
  function noteEndReason(r){ if (r) lastEndReason = String(r); }
  // Timeline of the call ("2.1s avatar: ready"), kept in memory and shown under the
  // end-of-call banner, so one screenshot says what happened and when.
  const callTrace = []; let callTraceT0 = Date.now();
  function resetTrace(){ callTrace.length = 0; callTraceT0 = Date.now(); }
  function trace(msg){
    callTrace.push(((Date.now() - callTraceT0) / 1000).toFixed(1) + 's ' + String(msg).slice(0, 140));
    if (callTrace.length > 60) callTrace.shift();
    try { console.log('[trace] ' + msg); } catch(e){}
  }
  function showEndToast(text){
    let t = $('callEndToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'callEndToast';
      t.style.cssText = 'position:fixed; left:12px; right:12px; top:calc(env(safe-area-inset-top, 0px) + 12px); z-index:99999; background:#2b1214; color:#ffb4ab; border:1px solid #7a2a2a; border-radius:14px; padding:12px 14px; font-size:13.5px; line-height:1.4; box-shadow:0 8px 28px rgba(0,0,0,0.5);';
      t.addEventListener('click', () => { t.style.display = 'none'; });
      document.body.appendChild(t);
    }
    t.textContent = '';
    const head = document.createElement('div');
    head.textContent = text;
    t.appendChild(head);
    if (callTrace.length) {
      const pre = document.createElement('div');
      pre.style.cssText = 'margin-top:8px; font:11px/1.45 ui-monospace,Menlo,monospace; color:#e8b8b2; white-space:pre-wrap; word-break:break-word;';
      pre.textContent = callTrace.slice(-14).join('\n');
      t.appendChild(pre);
      const copy = document.createElement('button');
      copy.textContent = 'Copy details';
      copy.style.cssText = 'margin-top:8px; padding:6px 12px; border-radius:10px; border:1px solid #7a2a2a; background:#3a1a1c; color:#ffd0ca; font-size:12px;';
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        const all = text + '\n' + callTrace.join('\n');
        try { navigator.clipboard.writeText(all); copy.textContent = 'Copied'; } catch(_) { copy.textContent = 'Copy failed'; }
      });
      t.appendChild(copy);
    }
    t.style.display = 'block';
    clearTimeout(t._hide);
    t._hide = setTimeout(() => { t.style.display = 'none'; }, 45000);
  }
  function endReasonText(reason){
    const r = String(reason || '').toLowerCase();
    if (r === 'browser_media_failed') return 'the connection between this app and the call server dropped (media link failed)';
    if (r === 'declined' || r === 'reject' || r === 'rejected') return 'the other person declined';
    if (r === 'busy') return 'the other person is busy';
    if (r === 'timeout' || r === 'no_answer' || r === 'unanswered') return 'nobody answered';
    if (r === 'user_ended' || r === 'ended' || r === 'remote_ended' || r === 'hangup') return 'the other side hung up';
    return reason ? String(reason) : 'unknown reason';
  }
  function showCallFailureAndEnd(message){
    trace('FAILURE: ' + message);
    noteEndReason(message);
    stopRingback();
    if ($('socialCallScreen')?.classList.contains('active')) {
      const lbl = $('socialCallStatusLabel');
      if (lbl) lbl.textContent = message || 'Call failed';
      setTimeout(() => { endSocialCall(); }, 2500);
    } else {
      $('prepErrorHint') && ($('prepErrorHint').textContent = message || 'Call failed');
      endSocialCall();
    }
  }

  // -------------------------------------------------------------
  // Incoming WhatsApp call (WaCalls engine)
  //
  // There is no phone UI here: an incoming call arrives at this app, and the
  // offer reaches the page through server.mjs's event bridge
  // (`wacalls_event` kind "incoming", carrying media audio|video). This is the
  // one place that can answer it, so it renders the offer and the two actions
  // that exist: answer (which accepts on WaCalls and opens the media leg with
  // the selected avatar as the outgoing video) and decline.
  // -------------------------------------------------------------
  let waCallsIncoming = null;

  function showIncomingWaCallsCall(evt){
    waCallsIncoming = { callId: evt.callId, peer: evt.peer || 'Unknown', media: evt.media || 'audio' };
    const banner = $('socialIncomingBanner');
    const title = $('socialIncomingTitle');
    const subEl = $('socialIncomingSub');
    if (title) title.textContent = `Incoming WhatsApp ${waCallsIncoming.media === 'video' ? 'video' : 'voice'} call`;
    if (subEl) subEl.textContent = `${waCallsIncoming.peer} · answering sends your ${selectedCallSource === 'avatar' ? 'Anam avatar' : 'Lucy 2.5 avatar'}`;
    if (banner) banner.style.display = 'block';
    startRingback();
  }

  function hideIncomingWaCallsCall(){
    waCallsIncoming = null;
    const banner = $('socialIncomingBanner');
    if (banner) banner.style.display = 'none';
    stopRingback();
  }

  $('socialIncomingDeclineBtn')?.addEventListener('click', async () => {
    const call = waCallsIncoming;
    hideIncomingWaCallsCall();
    if (!call) return;
    try {
      await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: call.callId }),
      });
    } catch(e) { console.warn('[WaCalls] decline failed:', e.message); }
  });

  $('socialIncomingAcceptBtn')?.addEventListener('click', async () => {
    const call = waCallsIncoming;
    const btn = $('socialIncomingAcceptBtn');
    if (!call) return;
    btn.disabled = true;
    btn.textContent = 'Answering…';
    try {
      await answerIncomingWaCallsCall(call);
    } catch(e) {
      console.error('[WaCalls] could not answer the call:', e.message);
      showCallFailureAndEnd(e.message || 'Could not answer the call');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Answer';
    }
  });

  // Accepts on WaCalls, then brings this page into the call exactly like an
  // outgoing one: mic + selected avatar, the media leg, and the call screen.
  async function answerIncomingWaCallsCall(call){
    const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: call.callId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `WaCalls could not answer (HTTP ${res.status})`);

    hideIncomingWaCallsCall();
    currentSocialPlatform = 'whatsapp';
    currentCallEngine = 'wacalls';
    selectedSocialContact = { name: call.peer, target: call.peer };
    setSocialCallContext('incoming', 'whatsapp', call.peer);

    const avatarAnswer = selectedCallSource === 'avatar';
    avatarRecoveries = 0; avatarRecovering = false;
    if (avatarAnswer) {
      CalleeAudioBus.start(); // the avatar listens to the caller; no microphone is opened
    } else if (!socialMicStream) {
      socialMicStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      if (!socialMicStream) throw new Error('Microphone permission required to answer a call');
    }
    await activeSocialSource().start({ forSocialCall: true });

    const useVoiceConversion = selectedCallSource === 'lucy' && LucyVoice.enabled && LucyVoice.canEnable();
    if (useVoiceConversion) {
      await LucyVoice.startForCall('whatsapp');
      // The playout is where the converted audio is assembled (it is fed by
      // channel 0x06 below); its sink is what puts those samples on the call's
      // "pcm" channel. Without it the leg would have nothing to send.
      await VoiceConversionPlayout.start();
    }

    showSocialCallScreen({ name: call.peer, label: `WhatsApp · WaCalls`, status: 'Connected' });

    // Same socket job as an outgoing call: events plus the RVC round trip
    // (raw mic up as 0x02, converted audio back as 0x06). Without this the
    // converter would never receive the caller's-side audio to convert.
    SocialCallMediaAdapter.startStreaming(activeSocialSource().getStream(), socialMicStream, {
      voiceConversion: useVoiceConversion,
      waCalls: true,
    });

    await WaCallsMediaLeg.open({
      callId: call.callId,
      video: call.media === 'video',
      source: selectedCallSource === 'avatar' ? 'anam' : 'lucy',
      voiceConversion: useVoiceConversion,
    });
    if (avatarAnswer) {
      const voice = await waitForAvatarAudio(8000);
      if (voice) WaCallsMediaLeg.attachOutgoingAudio(voice);
      else console.warn('[WaCalls] the avatar produced no audio track - the caller will not hear it');
    }

    // Our own video has to be signalled to WhatsApp for an incoming video call
    // (the peer asked for video; a silent leg would answer in audio only).
    if (call.media === 'video') {
      try {
        await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/video/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callId: call.callId }),
        });
        console.log(`[WaCalls] answered an incoming VIDEO call ${call.callId} - avatar video signalled`);
      } catch(e) {
        console.warn('[WaCalls] could not signal video for the answered call:', e.message);
      }
    }
  }

  // Brings the call screen up for a call that was not started from the prep
  // screen (an answered incoming call). Shared by both directions so the
  // layout reset and the timer behave identically.
  function showSocialCallScreen({ name, label, status }){
    $('callPrepModal').classList.remove('active');
    const callScr = $('socialCallScreen');
    callScr.classList.add('active');
    callScr.dataset.layout = 'pip';
    const remoteVid = $('socialRemoteVideo'), selfVid = $('socialSelfVideo');
    if (remoteVid && selfVid) {
      remoteVid.className = 'socialPipMain';
      selfVid.className = 'socialPipThumb';
      remoteVid.style.left = ''; remoteVid.style.top = ''; remoteVid.style.right = '';
      selfVid.style.left = ''; selfVid.style.top = ''; selfVid.style.right = '16px';
      selfVid.style.display = '';
    }
    const cleanName = String(name || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
    // The call screen no longer shows the callee's name or the engine pill.
    const targetNameEl = $('socialCallTargetName');
    if (targetNameEl) targetNameEl.textContent = cleanName || name || 'Contact';
    const platformPillEl = $('socialCallPlatformPill');
    if (platformPillEl) {
      platformPillEl.innerHTML = `<span>${label || 'WhatsApp'}</span>`;
      platformPillEl.className = 'pill whatsapp';
    }
    $('socialCallStatusLabel').textContent = status || 'Connected';
    clearInterval(socialCallDurationTimer);
    socialCallDurationTimer = null;
    // WaCalls: the clock starts when the other person actually picks up, not
    // while it is still starting up / ringing.
    if (currentCallEngine === 'wacalls') { $('socialCallTimer').textContent = '--:--'; }
    else startSocialCallTimer();
    syncAvatarSourceUi();
  }
  function startSocialCallTimer(){
    if (socialCallDurationTimer) return;
    $('socialCallTimer').textContent = '00:00';
    socialCallStartedAt = Date.now();
    socialCallDurationTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - socialCallStartedAt) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      $('socialCallTimer').textContent = `${m}:${s}`;
    }, 1000);
  }

  // -------------------------------------------------------------
  // Avatar video source - the runtime switch (Anam | Lucy 2.5).
  //
  // Same two sources the prep screen offers (LiveSwapMediaSource = Lucy 2.5
  // live face swap, SocialAnamSource = Anam's avatar); this one can be flipped
  // DURING a call, which switches the pixels the media leg sends from the very
  // next encoded frame. It also sets the default for the next call, and the
  // server records the switch so it shows up in the call log.
  // -------------------------------------------------------------
  function syncTestModeUi(){}
  function syncAvatarSourceUi(){
    syncTestModeUi();
    const sel = $('socialSourceSelect'), lbl = $('socialSourceLabel');
    if (sel) sel.value = selectedCallSource === 'avatar' ? 'anam' : 'lucy';
    if (lbl) lbl.textContent = selectedCallSource === 'avatar' ? 'Anam' : 'Lucy 2.5';
  }

  async function setSocialCallAvatarSource(source){
    const next = source === 'anam' ? 'anam' : 'lucy';
    const previous = selectedCallSource;
    selectedCallSource = next === 'anam' ? 'avatar' : 'lucy';
    // Keep the prep screen's tabs in step - it is the same choice.
    $('prepSourceLucyBtn')?.classList.toggle('active', selectedCallSource === 'lucy');
    $('prepSourceAvatarBtn')?.classList.toggle('active', selectedCallSource === 'avatar');
    const srcLabel = $('prepSourceLabel');
    if (srcLabel) srcLabel.textContent = selectedCallSource === 'avatar' ? 'AI Avatar (Anam)' : 'Live Swap / Lucy 2.5';
    syncAvatarSourceUi();
    LucyVoice.renderVoiceUi?.();

    if (previous !== selectedCallSource) {
      WaCallsMediaLeg.setAvatarSource(selectedCallSource);
      console.log(`[UI] avatar source switched to ${selectedCallSource === 'avatar' ? 'Anam' : 'Lucy 2.5'}`);
      // Recorded server-side too, so a mid-call switch appears in the call log
      // next to the call itself (best-effort - never blocks the switch).
      if (currentCallEngine === 'wacalls') {
        fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: selectedCallSource === 'avatar' ? 'anam' : 'lucy' }),
        }).catch(() => {});
      }
    }
  }

  $('socialSourceSelect')?.addEventListener('change', (e) => {
    setSocialCallAvatarSource(e.target.value);
  });

  // Every WaCalls event (server/wacalls.mjs's normalised vocabulary) lands
  // here. The call_state / wa_call_event mirrors the server also sends keep the
  // generic UI working; this handler is for what is WaCalls-specific: the
  // incoming-call offer, media ready/not ready, and the peer asking for video.
  function handleWaCallsEvent(evt){
    try { trace('event: ' + evt.kind + (evt.subtype ? '/' + evt.subtype : '') + (evt.reason ? ' (' + evt.reason + ')' : '')); } catch(_){}
    const lbl = $('socialCallStatusLabel');
    switch (evt.kind) {
      case 'incoming':
        // Ignore an offer while this app is already on a call (WaCalls itself
        // allows one active call per client id, so this is only about not
        // throwing an answer UI at a user who is mid-call).
        if ($('socialCallScreen')?.classList.contains('active')) {
          console.log(`[WaCalls] incoming call ${evt.callId} ignored - a call is already up`);
          return;
        }
        showIncomingWaCallsCall(evt);
        return;
      case 'media-ready':
        // subtype 'webrtc' only means OUR browser leg finished negotiating,
        // which happens while the callee's phone is still ringing. Treating
        // it as "answered" started the avatar (and its greeting) into a
        // ringing phone. Only the real call-status "connected" counts.
        if (evt.subtype === 'webrtc') return;
        if (evt.subtype !== 'unheld') fireCallAnswered();
        startSocialCallTimer();
        if (!callConnectedAt) {
          callConnectedAt = Date.now(); trace('call connected');
          scheduleAvatarGreeting();
          WaCallsMediaLeg.keyframeBurst(); // the callee's picture starts on a keyframe, then again shortly after
        }
        if (lbl) lbl.textContent = 'Connected';
        $('socialCallIdle') && ($('socialCallIdle').style.display = 'none');
        stopRingback();
        return;
      case 'media-not-ready':
        if (lbl && evt.subtype === 'held') lbl.textContent = 'On hold';
        return;
      case 'video-request': {
        // The peer wants video on a call that is up. Ask first (never silently
        // turn a camera on someone), then use the documented WaCalls path:
        // renegotiate the same peer connection, then tell WaCalls to signal the
        // upgrade to WhatsApp.
        // Do NOT use confirm() here: WhatsApp sends this request several times within a second, and a
        // blocking dialog freezes the page (audio, video and the media socket all stall), which made the
        // callee see buffering and the call drop with "browser_media_failed". This call is an avatar
        // video call, so just switch to video, once.
        if (!WaCallsMediaLeg.active || WaCallsMediaLeg.video || WaCallsMediaLeg.upgrading) return;
        WaCallsMediaLeg.upgrading = true;
        WaCallsMediaLeg.upgradeToVideo()
          .then(() => console.log('[WaCalls] call upgraded to video'))
          .catch((e) => console.warn('[WaCalls] video upgrade failed:', e.message))
          .finally(() => { WaCallsMediaLeg.upgrading = false; });
        return;
      }
      case 'ended':
        console.log(`[WaCalls] call ended (${evt.reason || 'ended'})`);
        lastRemoteEndReason = evt.reason || 'ended';
        hideIncomingWaCallsCall();
        if ($('socialCallScreen')?.classList.contains('active')) {
          // Not ended by the End button (that closes the screen first), so say why.
          noteEndReason('Call ended: ' + endReasonText(evt.reason));
          endSocialCall();
        }
        return;
      case 'error':
        console.warn(`[WaCalls] ${evt.error}`);
        return;
      default:
        return;
    }
  }

  function handleMediaWsMessage(msg){
    if (msg.type === 'wacalls_event') {
      handleWaCallsEvent(msg);
      return;
    }
    if (msg.type === 'vc_status') {
      // Live conversion state for the call that is up right now.
      LucyVoice.applyStatus(msg);
      return;
    }
    if (msg.type === 'wa_status' || msg.type === 'wa_qr' || msg.type === 'wa_pairing_code') {
      fetchConnectedStatus();
    }
    if (msg.type === 'wa_call_event' && currentSocialPlatform === 'whatsapp') {
      // Real WhatsApp call signaling status (Baileys' sock.ev.on('call', ...)
      // - genuinely reflects whether the other phone is ringing/answered/
      // declined). Was already being broadcast server-side but never
      // listened for here at all - the call screen had no way to reflect
      // any of it, same class of bug as Telegram's missing state polling.
      const lbl = $('socialCallStatusLabel');
      const status = msg.call?.status;
      if (status === 'offer' || status === 'ringing') {
        if (lbl) lbl.textContent = 'Ringing…';
        startRingback();
      } else if (status === 'accept') {
        if (lbl) lbl.textContent = 'Connected';
        const idle = $('socialCallIdle');
        if (idle) idle.style.display = 'none';
        stopRingback();
      } else if (status === 'reject' || status === 'timeout' || status === 'terminate') {
        stopRingback();
        if (status === 'reject') showCallFailureAndEnd('Call declined');
        else if (status === 'timeout') showCallFailureAndEnd('No answer');
        else {
          // The other side (or the network) ended it while the call screen was up - say so.
          if ($('socialCallScreen')?.classList.contains('active')) noteEndReason('Call ended: ' + endReasonText((msg.call && msg.call.reason) || lastRemoteEndReason || 'ended'));
          endSocialCall();
        }
      }
    }
    if (msg.type === 'call_state') {
      const lbl = $('socialCallStatusLabel');
      if (msg.state === 'ringing') {
        if (lbl) lbl.textContent = 'Ringing…';
        startRingback();
      } else if (msg.state === 'connecting') {
        if (lbl) lbl.textContent = 'Connecting…';
        startRingback(); // keep playing through connecting - stops only once truly connected
      } else if (msg.state === 'connected') {
        fireCallAnswered();
        if (lbl) lbl.textContent = 'Connected';
        const idle = $('socialCallIdle');
        if (idle) idle.style.display = 'none';
        stopRingback();
      } else if (msg.state === 'failed') {
        showCallFailureAndEnd(msg.error || 'Call failed');
      } else if (msg.state === 'ended') {
        stopRingback();
        // The call screen is still up, so this was NOT the End button: the other side
        // (or the network) ended it. Record why, so the banner can say so.
        if ($('socialCallScreen')?.classList.contains('active')) {
          noteEndReason('Call ended: ' + endReasonText(lastRemoteEndReason || 'ended'));
        }
        endSocialCall();
      }
    }
  }

  // -------------------------------------------------------------
  // Ringback tone (plays while the other side's phone is actually ringing,
  // i.e. real Telegram P2P calls - WhatsApp/PyTgCalls-Telegram calls don't
  // get real ringing state today so this simply never starts for them).
  // Generated with WebAudio rather than an audio file: a standard North-
  // American-style ringback cadence, 440Hz+480Hz combined tone, 2s on/4s
  // off, looped until the call connects or ends.
  // -------------------------------------------------------------
  let ringbackCtx = null, ringbackTimer = null, ringbackOscillators = [];
  function startRingback(){
    if (ringbackCtx) return; // already playing
    try {
      ringbackCtx = new (window.AudioContext || window.webkitAudioContext)();
      const playTone = () => {
        const gain = ringbackCtx.createGain();
        gain.gain.value = 0.05;
        gain.connect(ringbackCtx.destination);
        [440, 480].forEach((freq) => {
          const osc = ringbackCtx.createOscillator();
          osc.frequency.value = freq;
          osc.connect(gain);
          osc.start();
          ringbackOscillators.push(osc);
        });
        setTimeout(() => {
          ringbackOscillators.forEach((o) => { try { o.stop(); } catch(e){} });
          ringbackOscillators = [];
        }, 2000);
      };
      playTone();
      ringbackTimer = setInterval(playTone, 6000);
    } catch(e) { console.warn('[Ringback] could not start:', e.message); }
  }
  function stopRingback(){
    clearInterval(ringbackTimer);
    ringbackTimer = null;
    ringbackOscillators.forEach((o) => { try { o.stop(); } catch(e){} });
    ringbackOscillators = [];
    if (ringbackCtx) { ringbackCtx.close().catch(()=>{}); ringbackCtx = null; }
  }

  // -------------------------------------------------------------
  // Connected Accounts in Profile
  // -------------------------------------------------------------
  // WhatsApp access banner: locked / minutes left / Pro, or the real reason the
  // server refused (expired session, not approved, server not configured).
  // Pairing controls are disabled while locked - there is no point showing a
  // QR the server will not issue.
  const PRO_PRICE_LABEL = '₦15,000';
  function renderWaAccess(access, errorText){
    const tabs = $('waEngineWaCallsBtn')?.parentElement;
    if (!tabs) return;
    let box = $('waAccessBanner');
    if (!box) {
      box = document.createElement('div');
      box.id = 'waAccessBanner';
      box.style.cssText = 'margin:0 0 12px;padding:12px 14px;border-radius:12px;font-size:13.5px;line-height:1.45;';
      tabs.insertAdjacentElement('afterend', box);
    }
    let text = '', warn = false;
    if (errorText) { text = errorText; warn = true; }
    else if (access && !access.allowed) {
      warn = true;
      text = access.reason === 'no_minutes'
        ? `You have used all your WhatsApp minutes. Ask the admin for more, or upgrade to Pro (${PRO_PRICE_LABEL}).`
        : `WhatsApp calling is locked for your account. Ask the admin to open it for you, or upgrade to Pro (${PRO_PRICE_LABEL}).`;
    }
    else if (access && access.plan === 'pro') text = 'Pro: unlimited WhatsApp calling.';
    else if (access && !access.unlimited && access.minutesRemaining != null) text = `WhatsApp minutes left: ${access.minutesRemaining}`;
    box.textContent = text;
    box.style.display = text ? 'block' : 'none';
    box.style.background = warn ? 'rgba(224,164,88,0.14)' : 'rgba(37,211,102,0.12)';
    box.style.border = warn ? '1px solid rgba(224,164,88,0.45)' : '1px solid rgba(37,211,102,0.35)';
    box.style.color = warn ? '#f0c88a' : '#7be3a1';
    const locked = !!(access && !access.allowed);
    ['waRefreshQrBtn', 'waSessionPairBtn', 'waPhonePairBtn'].forEach((id) => {
      const b = $(id);
      if (b) { b.disabled = locked; b.style.opacity = locked ? '0.45' : ''; }
    });
    const qrBox = $('waQrBox');
    if (qrBox && locked) qrBox.style.display = 'none';
  }

  async function fetchConnectedStatus(){
    renderWaEngineUi();
    // Only the SELECTED engine is polled. The Green API route resolves the
    // caller's own Green API credentials, which a WaCalls user has no reason
    // to be asked for; the WaCalls instance is a different session entirely.
    // Switching engines re-polls, nothing switches on its own.
    if (waEngine() === 'wacalls') {
      await fetchWaCallsStatus();
    }

    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/status', { headers: { ...(await authHeader()) } });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        renderWaAccess(null, err.error || `The server refused the request (${res.status}).`);
        return;
      }
      const data = await res.json();
      renderWaAccess(data.access);

      if (waEngine() !== 'wacalls') {
        // WhatsApp status (Green API)
        const wa = data.whatsapp || {};
        const waStatusEl = $('whatsappAccountStatus');
        const waBadgeEl = $('whatsappAccountBadge');
        if (wa.connected && wa.user) {
          if (waStatusEl) waStatusEl.textContent = `Connected as ${wa.user.phone ? '+' + wa.user.phone : wa.user.name}`;
          if (waBadgeEl) {
            waBadgeEl.textContent = 'Connected';
            waBadgeEl.classList.add('connected');
          }
          $('waDetailStatus').textContent = 'Connected';
          $('waDetailSub').textContent = `Linked phone: +${wa.user.phone || ''}`;
          $('waConnectedNumber').textContent = `+${wa.user.phone || ''} (${wa.user.name || 'WhatsApp User'})`;
          $('waNotConnectedView').style.display = 'none';
          $('waConnectedView').style.display = 'block';
          $('choiceWhatsAppSubtitle').textContent = `Connected (+${wa.user.phone || ''})`;
        } else {
          if (waStatusEl) waStatusEl.textContent = 'Not connected';
          if (waBadgeEl) {
            waBadgeEl.textContent = 'Connect';
            waBadgeEl.classList.remove('connected');
          }
          $('waDetailStatus').textContent = wa.status === 'scan_qr' ? 'Waiting for scan…' : 'Disconnected';
          $('waDetailSub').textContent = 'Scan QR code or use pairing code';
          $('waNotConnectedView').style.display = 'block';
          $('waConnectedView').style.display = 'none';
          $('choiceWhatsAppSubtitle').textContent = 'Live Video Call with Lucy 2.5';

          if (wa.qr) {
            const img = $('waQrImg');
            if (img) { img.src = wa.qr; img.style.display = 'block'; }
            const load = $('waQrLoading');
            if (load) load.style.display = 'none';
          }
        }
      }

      // Telegram status
      const tg = {}; // Telegram: coming soon, ignore bridge status
      const tgStatusEl = $('telegramAccountStatus');
      const tgBadgeEl = $('telegramAccountBadge');
      if (tg.connected && tg.user) {
        const u = tg.user;
        const disp = u.username ? `@${u.username}` : (u.phone_number || u.first_name || 'Connected');
        if (tgStatusEl) tgStatusEl.textContent = `Connected as ${disp}`;
        if (tgBadgeEl) {
          tgBadgeEl.textContent = 'Connected';
          tgBadgeEl.classList.add('connected');
        }
        $('tgDetailStatus').textContent = 'Connected';
        $('tgDetailSub').textContent = `Linked account: ${disp}`;
        $('tgConnectedUser').textContent = `${u.first_name || ''} (${disp})`;
        $('tgNotConnectedView').style.display = 'none';
        $('tgConnectedView').style.display = 'block';
        $('choiceTelegramSubtitle').textContent = `Connected (${disp})`;
      } else {
        if (tgStatusEl) tgStatusEl.textContent = 'Coming soon';
        if (tgBadgeEl) {
          tgBadgeEl.textContent = 'Coming soon';
          tgBadgeEl.classList.remove('connected');
        }
        $('tgDetailStatus').textContent = 'Disconnected';
        $('tgDetailSub').textContent = 'Enter phone number to receive login code';
        $('tgNotConnectedView').style.display = 'block';
        $('tgConnectedView').style.display = 'none';
        $('choiceTelegramSubtitle').textContent = 'Coming soon';
      }
    } catch(err){
      console.warn('[fetchConnectedStatus] note:', err.message);
    }
  }

  // Profile -> WhatsApp
  // Fetches the pairing QR for whichever engine is selected, and paints it.
  // Green API's route returns a ready-made data URL; the WaCalls route renders
  // the raw QR payload WaCalls puts on its event stream into one server-side
  // (see server.mjs). Same <img>, two engines.
  async function refreshWaQr(){
    const engine = waEngine();
    const endpoint = engine === 'wacalls'
      ? '/api/social-call/wacalls/qr'
      : '/api/social-call/whatsapp/qr';
    const load = $('waQrLoading'), img = $('waQrImg');
    if (load) { load.style.display = 'block'; load.textContent = 'Generating QR code…'; }
    if (img) img.style.display = 'none';
    try {
      const r = await fetch(SOCIAL_CALL_API_BASE + endpoint, {
        method: 'POST',
        headers: { ...(await authHeader()) },
      });
      const data = await r.json().catch(() => ({}));
      if (data.access || String(data.code || '').startsWith('whatsapp_')) renderWaAccess(data.access);
      if (data.dataUrl && img) {
        img.src = data.dataUrl;
        img.style.display = 'block';
        if (load) load.style.display = 'none';
      } else if (load) {
        load.textContent = data.error || (data.alreadyAuthorized ? 'Already linked on this engine.' : 'No QR available yet — still connecting.');
      }
    } catch(e) {
      if (load) load.textContent = e.message;
    }
  }

  $('openWhatsAppConnect')?.addEventListener('click', async () => {
    $('whatsappConnectScreen').classList.add('active');
    renderWaEngineUi();
    try {
      await refreshWaQr();
      await fetchConnectedStatus();
    } catch(e) {
      showErrorToast ? showErrorToast(e.message) : console.warn('[WhatsApp QR] note:', e.message);
    }
    clearInterval(waStatusPollTimer);
    waStatusPollTimer = setInterval(fetchConnectedStatus, 3000);
  });
  $('closeWhatsAppConnect')?.addEventListener('click', () => {
    $('whatsappConnectScreen').classList.remove('active');
    clearInterval(waStatusPollTimer);
  });

  $('waRefreshQrBtn')?.addEventListener('click', async () => {
    await refreshWaQr();
    await fetchConnectedStatus();
  });

  $('waDisconnectBtn')?.addEventListener('click', async () => {
    // Only the SELECTED engine is disconnected - the two keep independent
    // WhatsApp sessions, so unlinking one must not touch the other.
    const engine = waEngine();
    if (!confirm(`Disconnect WhatsApp from ${waEngineLabel(engine)}?`)) return;
    const endpoint = engine === 'wacalls'
      ? '/api/social-call/wacalls/logout'
      : '/api/social-call/whatsapp/disconnect';
    try {
      const r = await fetch(SOCIAL_CALL_API_BASE + endpoint, {
        method: 'POST',
        headers: { ...(await authHeader()) },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok && data.error) throw new Error(data.error);
    } catch(e) {
      const sub = $('waDetailSub');
      if (sub) sub.textContent = e.message;
    }
    await fetchConnectedStatus();
  });

  // Profile -> Telegram
  $('openTelegramConnect')?.addEventListener('click', () => {
    return; // Telegram: coming soon
    $('telegramConnectScreen').classList.add('active');
    fetchConnectedStatus();
    fetchP2pStatus();
  });
  $('closeTelegramConnect')?.addEventListener('click', () => {
    $('telegramConnectScreen').classList.remove('active');
  });

  $('tgSendCodeBtn')?.addEventListener('click', async () => {
    const phone = $('tgPhoneInput').value.trim();
    if (!phone) return alert('Enter phone number');
    $('tgSendCodeBtn').textContent = 'Sending code…';
    $('tgSendCodeHint').textContent = '';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/send_code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phone }),
      });
      const data = await res.json();
      if (data.status === 'code_sent') {
        $('tgStepPhone').style.display = 'none';
        $('tgStepCode').style.display = 'block';
      } else {
        $('tgSendCodeHint').textContent = data.error || 'Failed to send code';
      }
    } catch(e){
      $('tgSendCodeHint').textContent = e.message;
    } finally {
      $('tgSendCodeBtn').textContent = 'Send Code';
    }
  });

  $('tgSignInBtn')?.addEventListener('click', async () => {
    const phone = $('tgPhoneInput').value.trim();
    const code = $('tgCodeInput').value.trim();
    const password = $('tgPasswordInput').value.trim();
    if (!code) return alert('Enter verification code');
    $('tgSignInBtn').textContent = 'Signing in…';
    $('tgSignInHint').textContent = '';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/sign_in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phone, phone_code: code, password }),
      });
      const data = await res.json();
      if (data.status === '2fa_required') {
        $('tgPasswordCard').style.display = 'block';
        $('tgSignInHint').textContent = '2FA password required';
      } else if (data.status === 'connected') {
        fetchConnectedStatus();
      } else {
        $('tgSignInHint').textContent = data.error || 'Failed to sign in';
      }
    } catch(e){
      $('tgSignInHint').textContent = e.message;
    } finally {
      $('tgSignInBtn').textContent = 'Confirm & Connect';
    }
  });

  $('tgDisconnectBtn')?.addEventListener('click', async () => {
    if (!confirm('Disconnect Telegram?')) return;
    await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/disconnect', { method: 'POST' });
    await fetchConnectedStatus();
  });

  // -------------------------------------------------------------
  // Real Calling (P2P) sign-in - a separate Telegram session from the one
  // above, used only for actually placing/ringing calls (tgcalls_bridge).
  // Without this, calls were failing silently before ever ringing -
  // there was no way to authenticate this engine at all until now.
  // -------------------------------------------------------------
  async function fetchP2pStatus(){
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/p2p/status');
      const data = await res.json();
      const connected = !!data.connected;
      $('tgP2pStatus').textContent = connected ? 'Connected' : (data.error ? 'Error' : 'Not connected');
      $('tgP2pNotConnectedView').style.display = connected ? 'none' : 'block';
      $('tgP2pConnectedView').style.display = connected ? 'block' : 'none';
    } catch(e){
      $('tgP2pStatus').textContent = 'Unavailable';
    }
  }

  $('tgP2pSendCodeBtn')?.addEventListener('click', async () => {
    const phone = $('tgP2pPhoneInput').value.trim();
    if (!phone) return alert('Enter phone number');
    $('tgP2pSendCodeBtn').textContent = 'Sending code…';
    $('tgP2pSendCodeHint').textContent = '';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/p2p/send_code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (data.status === 'code_sent') {
        $('tgP2pStepPhone').style.display = 'none';
        $('tgP2pStepCode').style.display = 'block';
      } else if (data.status === 'connected') {
        // Already authorized (e.g. a restored session) - no code needed.
        fetchP2pStatus();
      } else {
        $('tgP2pSendCodeHint').textContent = data.error || 'Failed to send code';
      }
    } catch(e){
      $('tgP2pSendCodeHint').textContent = e.message;
    } finally {
      $('tgP2pSendCodeBtn').textContent = 'Send Code';
    }
  });

  $('tgP2pSignInBtn')?.addEventListener('click', async () => {
    const code = $('tgP2pCodeInput').value.trim();
    const password = $('tgP2pPasswordInput').value.trim();
    if (!code) return alert('Enter verification code');
    $('tgP2pSignInBtn').textContent = 'Signing in…';
    $('tgP2pSignInHint').textContent = '';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/p2p/sign_in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password }),
      });
      const data = await res.json();
      if (data.status === '2fa_required') {
        $('tgP2pPasswordCard').style.display = 'block';
        $('tgP2pSignInHint').textContent = '2FA password required';
      } else if (data.status === 'connected') {
        fetchP2pStatus();
      } else {
        $('tgP2pSignInHint').textContent = data.error || 'Failed to sign in';
      }
    } catch(e){
      $('tgP2pSignInHint').textContent = e.message;
    } finally {
      $('tgP2pSignInBtn').textContent = 'Confirm & Connect';
    }
  });

  $('tgP2pDisconnectBtn')?.addEventListener('click', async () => {
    if (!confirm('Disconnect real calling?')) return;
    await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/p2p/disconnect', { method: 'POST' });
    await fetchP2pStatus();
  });

  // -------------------------------------------------------------
  // Keep-alive toggle (test-mode only) - see server.mjs for why this exists.
  // -------------------------------------------------------------
  function setKeepAliveUI(on){
    const btn = $('keepAliveToggle');
    const hint = $('keepAliveHint');
    if (btn) btn.dataset.on = on ? 'true' : 'false';
    if (hint) hint.textContent = on
      ? 'On — pinging every 10 min so Render stays warm'
      : 'Off — Render free tier sleeps after ~15 min idle';
  }
  async function fetchKeepAliveStatus(){
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/keepalive/status');
      const data = await res.json();
      setKeepAliveUI(!!data.enabled);
    } catch(e){ console.warn('[KeepAlive] status note:', e.message); }
  }
  $('keepAliveToggle')?.addEventListener('click', async () => {
    const btn = $('keepAliveToggle');
    const next = btn.dataset.on !== 'true';
    btn.disabled = true;
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/keepalive/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      setKeepAliveUI(!!data.enabled);
    } catch(e){
      alert('Could not update keep-alive: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });
  fetchKeepAliveStatus();

  // -------------------------------------------------------------
  // Call Flow: Home -> Choose how to call
  // -------------------------------------------------------------
  $('headerCallBtn')?.addEventListener('click', () => {
    $('callChoiceModal').classList.add('active');
    fetchConnectedStatus();
  });
  $('closeCallChoiceBtn')?.addEventListener('click', () => {
    $('callChoiceModal').classList.remove('active');
  });

  $('chooseAiCallBtn')?.addEventListener('click', () => {
    $('callChoiceModal').classList.remove('active');
    startCall(); // Original Anam AI direct call
  });

  $('chooseWhatsAppCallBtn')?.addEventListener('click', () => {
    $('callChoiceModal').classList.remove('active');
    openContactPicker('whatsapp');
  });

  $('chooseTelegramCallBtn')?.addEventListener('click', () => {
    return; // Telegram: coming soon
    $('callChoiceModal').classList.remove('active');
    openContactPicker('telegram');
  });

  // Contact Picker
  let allLoadedContacts = [];
  async function openContactPicker(platform) {
    currentSocialPlatform = platform;
    $('contactPickerModal').classList.add('active');
    $('contactPickerTitle').textContent = platform === 'whatsapp' ? 'WhatsApp Contacts' : 'Telegram Contacts';
    $('contactPickerPlatformIcon').innerHTML = platform === 'whatsapp'
      ? '<span style="color:#25D366;"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2ZM12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.59 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67ZM8.79 7.34C8.61 7.34 8.31 7.41 8.06 7.68C7.81 7.95 7.11 8.61 7.11 9.94C7.11 11.27 8.08 12.55 8.22 12.73C8.36 12.92 10.13 15.65 12.84 16.82C13.49 17.1 13.99 17.26 14.38 17.39C15.04 17.6 15.64 17.57 16.11 17.5C16.64 17.42 17.73 16.84 17.96 16.19C18.19 15.54 18.19 14.99 18.12 14.87C18.05 14.75 17.87 14.68 17.6 14.54C17.33 14.4 16 13.75 15.75 13.66C15.5 13.57 15.32 13.52 15.14 13.79C14.96 14.07 14.44 14.68 14.28 14.87C14.13 15.05 13.97 15.07 13.7 14.94C13.43 14.8 12.56 14.52 11.53 13.6C10.73 12.89 10.19 12.01 10.03 11.74C9.87 11.46 10.01 11.31 10.15 11.18C10.27 11.06 10.42 10.86 10.56 10.7C10.7 10.54 10.75 10.42 10.84 10.24C10.93 10.06 10.89 9.9 10.82 9.76C10.75 9.62 10.2 8.27 9.97 7.73C9.75 7.2 9.53 7.28 9.36 7.27C9.21 7.26 9.01 7.26 8.81 7.26L8.79 7.34Z"/></svg></span>'
      : '<span style="color:#2AABEE;"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg></span>';

    $('contactSearchInput').value = '';
    $('callDirectBtn').style.display = 'none';

    const container = $('contactsListContainer');
    container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--dim); font-size:13px;">Loading contacts…</div>';

    // WhatsApp contacts come from the Green API directory. WaCalls has no
    // contact directory of its own (its API is sessions, pairing and calls),
    // so on the WaCalls engine this list is only populated when the user also
    // has Green API credentials - and calling a typed number directly has
    // always been supported regardless.
    if (platform === 'whatsapp' && waEngine() === 'wacalls') {
      allLoadedContacts = savedContactsForPicker();
      if (!allLoadedContacts.length) {
        container.innerHTML = '<div style="text-align:center; padding:30px 16px; color:var(--dim); font-size:13.5px; line-height:1.5;">No saved contacts yet.<br>Add them in the Contacts tab, or type a number above to call.</div>';
      } else {
        renderContactsList(allLoadedContacts);
      }
      return;
    }
    const endpoint = platform === 'telegram'
      ? (SOCIAL_CALL_API_BASE + '/api/social-call/telegram/contacts')
      : (SOCIAL_CALL_API_BASE + '/api/social-call/whatsapp/contacts');
    try {
      const res = await fetch(endpoint, { headers: { ...(await authHeader()) } });
      const data = await res.json();

      if (!res.ok) {
        container.innerHTML = `<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:13px;">Error: ${data.error || 'Could not load contacts'}</div>`;
        allLoadedContacts = [];
        return;
      }

      allLoadedContacts = data.contacts || [];

      if (!allLoadedContacts.length) {
        container.innerHTML = `
          <div style="text-align:center; padding:30px 16px; color:var(--dim); font-size:13.5px; line-height:1.5;">
            No synced contacts found.<br>Type any phone number or username above to call.
          </div>
        `;
      } else {
        renderContactsList(allLoadedContacts);
      }
    } catch(err) {
      container.innerHTML = `<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:13px;">Error: ${err.message}</div>`;
    }
  }

  function renderContactsList(list){
    const container = $('contactsListContainer');
    if (!list.length) {
      container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--dim); font-size:13px;">No matching contacts</div>';
      return;
    }
    container.innerHTML = list.map(c => {
      const name = c.name || c.first_name || c.phone || c.target || 'Contact';
      const target = c.phone || c.phone_number || c.username || c.id || c.target;
      const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
      return `
        <div class="contactRow" data-contact-target="${String(target).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}" data-contact-name="${String(name).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">
          <div class="contactAvatar">${initials}</div>
          <div class="contactMain">
            <div class="contactName">${name.replace(/</g,'&lt;')}</div>
            <div class="contactSub">${target.replace(/</g,'&lt;')}</div>
          </div>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.contactRow').forEach(el => {
      el.addEventListener('click', () => {
        selectContactForCall({
          name: el.dataset.contactName,
          target: el.dataset.contactTarget,
        });
      });
    });
  }

  $('contactSearchInput')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const btn = $('callDirectBtn');
    if (q.length >= 3) {
      btn.style.display = 'inline-block';
      btn.textContent = 'Call ' + (q.length > 12 ? q.slice(0, 10) + '…' : q);
    } else {
      btn.style.display = 'none';
    }

    if (!q) {
      renderContactsList(allLoadedContacts);
    } else {
      const filtered = allLoadedContacts.filter(c => {
        const name = (c.name || c.first_name || '').toLowerCase();
        const target = (c.phone || c.phone_number || c.username || '').toLowerCase();
        return name.includes(q) || target.includes(q);
      });
      renderContactsList(filtered);
    }
  });

  $('callDirectBtn')?.addEventListener('click', async () => {
    const typed = $('contactSearchInput').value.trim();
    if (!typed) return;

    if (currentSocialPlatform === 'telegram') {
      // Never pass a raw phone number/username as target - tgcalls_bridge
      // needs a real numeric Telegram user id (and derives the access_hash
      // from that at call time). Resolve through the authenticated
      // account's own Telegram session first.
      const btn = $('callDirectBtn');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Looking up…';
      try {
        const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: typed }),
        });
        const data = await res.json();
        if (!res.ok || !data.id) {
          alert(data.error || 'Could not find a Telegram user for that number/username');
          return;
        }
        const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username || typed;
        selectContactForCall({ name, target: data.id });
      } catch(e) {
        alert('Lookup failed: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      return;
    }

    if (currentSocialPlatform === 'whatsapp' && waEngine() === 'wacalls') {
      // WaCalls has no registration-lookup endpoint, so there is nothing to
      // check server-side here: the number is used as typed and WaCalls will
      // report a real failure (or a real call) when the call is placed. Making
      // the check up client-side would just be a claim we cannot back.
      selectContactForCall({ name: typed, target: typed });
      return;
    }


    selectContactForCall({ name: typed, target: typed });
  });

  $('closeContactPicker')?.addEventListener('click', () => {
    $('contactPickerModal').classList.remove('active');
  });

  // ---------------------------------------------------------------
  // Saved contacts (Contacts tab). Stored on this device (localStorage):
  // { id, name, cc, number, target } where target is the full international
  // number as digits - exactly what WaCalls wants for a call.
  // ---------------------------------------------------------------
  const CONTACTS_KEY = 'lc_saved_contacts_v1';
  let editingContactId = null;
  // Source of truth is the Supabase `contacts` table (sql/009_contacts.sql);
  // this array is the in-memory copy the synchronous renderers read, and
  // localStorage is kept only as an offline fallback / one-time migration source.
  let savedContactsCache = null;
  const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
  function readLocalContacts(){
    try {
      const list = JSON.parse(localStorage.getItem(CONTACTS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch(e){ return []; }
  }
  function loadSavedContacts(){
    return savedContactsCache || readLocalContacts();
  }
  function storeSavedContacts(list){
    savedContactsCache = list;
    try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(list)); return true; }
    catch(e){ return false; }
  }
  const CONTACT_COLS = 'id,name,cc,number,target';
  // Pulls the user's contacts from Supabase and uploads any that only exist on
  // this device (contacts saved before the cloud table existed).
  async function syncSavedContacts(){
    if (!currentUser) return;
    try {
      const { data, error } = await supabase.from('contacts').select(CONTACT_COLS).order('name');
      if (error) throw error;
      const cloud = data || [];
      const have = new Set(cloud.map(c => c.target));
      const missing = readLocalContacts().filter(c => c && c.target && !have.has(c.target));
      if (missing.length) {
        const rows = missing.map(c => ({ user_id: currentUser.id, name: c.name, cc: c.cc, number: c.number, target: c.target }));
        const { data: ins, error: e2 } = await supabase.from('contacts')
          .upsert(rows, { onConflict: 'user_id,target' }).select(CONTACT_COLS);
        if (!e2 && ins) cloud.push(...ins);
        else if (e2) console.warn('[contacts] could not upload local contacts:', e2.message);
      }
      storeSavedContacts(cloud);
      renderContactsTab();
    } catch(e) {
      console.warn('[contacts] Supabase sync failed, using this device\'s copy:', e.message || e);
    }
  }
  async function saveContactToCloud(contact){
    if (!currentUser) return { error: { message: 'not signed in' } };
    const row = { user_id: currentUser.id, name: contact.name, cc: contact.cc, number: contact.number, target: contact.target };
    if (isUuid(contact.id)) {
      return supabase.from('contacts').update(row).eq('id', contact.id).select(CONTACT_COLS).single();
    }
    return supabase.from('contacts').upsert(row, { onConflict: 'user_id,target' }).select(CONTACT_COLS).single();
  }
  function savedContactsForPicker(){
    return loadSavedContacts()
      .slice().sort((a, b) => a.name.localeCompare(b.name))
      .map(c => ({ name: c.name, phone: c.target }));
  }
  function prettyNumber(c){
    return '+' + c.cc + ' ' + c.number;
  }
  function renderContactsTab(){
    const box = $('contactsTabList');
    if (!box) return;
    const q = ($('contactsTabSearch')?.value || '').trim().toLowerCase();
    const all = loadSavedContacts().slice().sort((a, b) => a.name.localeCompare(b.name));
    const list = q ? all.filter(c => c.name.toLowerCase().includes(q) || c.target.includes(q.replace(/\D/g, '') || '\u0000')) : all;
    box.textContent = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'emptyState';
      empty.textContent = all.length ? 'No matching contacts.' : 'No contacts yet. Tap + Add to save one, then tap it here to call.';
      box.appendChild(empty);
      return;
    }
    list.forEach(c => {
      const row = document.createElement('div');
      row.className = 'contactRow';
      const av = document.createElement('div');
      av.className = 'contactAvatar';
      av.textContent = c.name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
      const main = document.createElement('div');
      main.className = 'contactMain';
      const nm = document.createElement('div');
      nm.className = 'contactName';
      nm.textContent = c.name;
      const sub = document.createElement('div');
      sub.className = 'contactSub';
      sub.textContent = prettyNumber(c) + ' · WhatsApp';
      main.append(nm, sub);
      const edit = document.createElement('button');
      edit.className = 'contactEditBtn';
      edit.setAttribute('aria-label', 'Edit ' + c.name);
      edit.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
      edit.addEventListener('click', (e) => { e.stopPropagation(); openContactEditor(c.id); });
      row.append(av, main, edit);
      // Tapping a saved contact goes straight to Call Preparation.
      row.addEventListener('click', () => {
        currentSocialPlatform = 'whatsapp';
        selectContactForCall({ name: c.name, target: c.target });
      });
      box.appendChild(row);
    });
  }
  function openContactEditor(id){
    editingContactId = id || null;
    const c = id ? loadSavedContacts().find(x => x.id === id) : null;
    $('contactEditorTitle').textContent = c ? 'Edit contact' : 'New contact';
    $('contactNameInput').value = c ? c.name : '';
    $('contactCCInput').value = c ? c.cc : ($('waPhoneCC')?.value.replace(/\D/g, '') || '234');
    $('contactNumInput').value = c ? c.number : '';
    $('contactEditorError').textContent = '';
    $('contactDeleteBtn').style.display = c ? 'block' : 'none';
    $('contactEditor').classList.add('active');
  }
  $('addContactBtn')?.addEventListener('click', () => openContactEditor(null));
  $('closeContactEditor')?.addEventListener('click', () => $('contactEditor').classList.remove('active'));
  $('contactsTabSearch')?.addEventListener('input', renderContactsTab);
  $('contactSaveBtn')?.addEventListener('click', async () => {
    const err = $('contactEditorError');
    const name = $('contactNameInput').value.trim();
    const cc = $('contactCCInput').value.replace(/\D/g, '');
    const number = $('contactNumInput').value.replace(/\D/g, '').replace(/^0+/, '');
    if (!name) { err.textContent = 'Enter a name.'; return; }
    if (!cc) { err.textContent = 'Enter the country code first (e.g. 234).'; return; }
    if (number.length < 6) { err.textContent = 'Enter the phone number after the country code.'; return; }
    const target = cc + number;
    const list = loadSavedContacts().slice();
    const dupe = list.find(x => x.target === target && x.id !== editingContactId);
    if (dupe) { err.textContent = 'That number is already saved as "' + dupe.name + '".'; return; }
    const existing = editingContactId ? list.find(x => x.id === editingContactId) : null;
    let saved = { id: existing ? existing.id : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, cc, number, target };
    // Cloud first. If it fails (offline, table not created yet) the contact is
    // still kept on this device and uploaded by the next sync.
    const { data: cloudRow, error: cloudErr } = await saveContactToCloud(saved);
    if (cloudRow) saved = cloudRow;
    else console.warn('[contacts] saved on this device only:', cloudErr && cloudErr.message);
    const i = list.findIndex(x => x.id === (existing ? existing.id : saved.id));
    if (i >= 0) list[i] = saved; else list.push(saved);
    if (!storeSavedContacts(list)) { err.textContent = 'Could not save on this device (storage is blocked or full).'; return; }
    $('contactEditor').classList.remove('active');
    renderContactsTab();
  });
  $('contactDeleteBtn')?.addEventListener('click', async () => {
    if (!editingContactId) return;
    if (!confirm('Delete this contact?')) return;
    if (isUuid(editingContactId)) {
      const { error } = await supabase.from('contacts').delete().eq('id', editingContactId);
      if (error) console.warn('[contacts] cloud delete failed:', error.message);
    }
    storeSavedContacts(loadSavedContacts().filter(x => x.id !== editingContactId));
    $('contactEditor').classList.remove('active');
    renderContactsTab();
  });

  // Call Preparation
  function selectContactForCall(contact){
    selectedSocialContact = contact;
    $('contactPickerModal').classList.remove('active');
    $('callPrepModal').classList.add('active');
    loadAnamSdk().catch(() => {}); // preload the avatar library so the first call doesn't pay for it

    $('prepContactName').textContent = contact.name || contact.target;
    $('prepContactDetails').textContent = `${contact.target} • ${currentSocialPlatform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}`;
    const badge = $('prepPlatformBadge');
    badge.textContent = currentSocialPlatform === 'whatsapp' ? 'WhatsApp' : 'Telegram';
    badge.className = `platformBadge ${currentSocialPlatform}`;

    $('prepPlatformIcon').innerHTML = currentSocialPlatform === 'whatsapp'
      ? '<span style="color:#25D366;"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2ZM12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.59 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67ZM8.79 7.34C8.61 7.34 8.31 7.41 8.06 7.68C7.81 7.95 7.11 8.61 7.11 9.94C7.11 11.27 8.08 12.55 8.22 12.73C8.36 12.92 10.13 15.65 12.84 16.82C13.49 17.1 13.99 17.26 14.38 17.39C15.04 17.6 15.64 17.57 16.11 17.5C16.64 17.42 17.73 16.84 17.96 16.19C18.19 15.54 18.19 14.99 18.12 14.87C18.05 14.75 17.87 14.68 17.6 14.54C17.33 14.4 16 13.75 15.75 13.66C15.5 13.57 15.32 13.52 15.14 13.79C14.96 14.07 14.44 14.68 14.28 14.87C14.13 15.05 13.97 15.07 13.7 14.94C13.43 14.8 12.56 14.52 11.53 13.6C10.73 12.89 10.19 12.01 10.03 11.74C9.87 11.46 10.01 11.31 10.15 11.18C10.27 11.06 10.42 10.86 10.56 10.7C10.7 10.54 10.75 10.42 10.84 10.24C10.93 10.06 10.89 9.9 10.82 9.76C10.75 9.62 10.2 8.27 9.97 7.73C9.75 7.2 9.53 7.28 9.36 7.27C9.21 7.26 9.01 7.26 8.81 7.26L8.79 7.34Z"/></svg></span>'
      : '<span style="color:#2AABEE;"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg></span>';

    // Mic check
    if (socialMicStream) {
      $('prepMicStatus').textContent = 'Microphone: Active';
      $('prepEnableMicBtn').style.display = 'none';
    } else {
      $('prepMicStatus').textContent = 'Microphone: Click to allow';
      $('prepEnableMicBtn').style.display = 'inline-block';
    }

    $('prepLucyStatus').textContent = lucyKeySet() ? 'Lucy 2.5: Ready to stream' : 'Lucy 2.5: Ready (using camera)';

    // Check whether the backend can convert the outgoing voice (voice-changer
    // reachable + an RVC model loaded) so the prep screen can say so up front
    // instead of only finding out at call time. Lucy 2.5 only - see the
    // renderVoiceUi() call in each source button's handler.
    LucyVoice.refresh();
    // Shows/hides the WhatsApp engine row and labels whichever engine this
    // call will actually go out on.
    renderWaEngineUi();
  }

  $('prepEnableMicBtn')?.addEventListener('click', async () => {
    try {
      socialMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      $('prepMicStatus').textContent = 'Microphone: Active';
      $('prepEnableMicBtn').style.display = 'none';
    } catch(e) {
      $('prepMicStatus').textContent = 'Microphone access denied';
    }
  });

  $('closeCallPrep')?.addEventListener('click', () => {
    $('callPrepModal').classList.remove('active');
  });

  // Step 4 & 5: Start Lucy 2.5 Live Swap automatically & place call
  $('prepStartCallActionBtn')?.addEventListener('click', placeSocialCall);

  // -------------------------------------------------------------
  // WhatsApp calling via Green API's calls SDK - unlike Telegram, there is
  // no server-side "place a call" REST endpoint for Green API; calling is
  // browser-side WebRTC that connects directly to their infrastructure.
  // Replaces the old Baileys-based waBridge.startCall()/hangup(), which
  // never worked because Baileys itself never successfully paired on this
  // deployment (WhatsApp very likely blocking datacenter IPs from linking
  // a device - see the Green API migration notes).
  // NOTE: confirmed by reading the SDK's own source directly - it is
  // audio-only. No video call support exists in this library at all.
  // -------------------------------------------------------------
  let gaClient = null, gaCalls = null;

  async function startGreenApiCall(target, options = {}){
    const voiceConversion = !!options.voiceConversion;
    const cfgRes = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/whatsapp/call-config', {
      headers: { ...(await authHeader()) },
    });
    const cfg = await cfgRes.json();
    if (!cfgRes.ok || !cfg.apiUrl || !cfg.idInstance || !cfg.apiTokenInstance) {
      throw new Error(cfg.error || 'Add your Green API credentials in Profile settings first');
    }

    const { GreenApiVoipClient } = await import('https://esm.sh/@green-api/whatsapp-api-calls-client-js@2.0.0');
    gaClient = new GreenApiVoipClient({
      apiUrl: cfg.apiUrl,
      idInstance: cfg.idInstance,
      apiTokenInstance: cfg.apiTokenInstance,
    });
    gaCalls = gaClient.connectCalls();

    const lbl = $('socialCallStatusLabel');
    gaCalls.addEventListener('state', (event) => {
      const kind = event.detail?.kind;
      if (kind === 'out-call') { if (lbl) lbl.textContent = 'Ringing…'; startRingback(); }
      else if (kind === 'on-call') {
        if (lbl) lbl.textContent = 'Connected';
        $('socialCallIdle') && ($('socialCallIdle').style.display = 'none');
        stopRingback();
      }
    });
    gaCalls.addEventListener('end-call', () => { stopRingback(); endSocialCall(); });
    gaCalls.addEventListener('error', (event) => {
      showCallFailureAndEnd(event.detail?.message || 'WhatsApp call error');
    });
    gaCalls.addEventListener('remote-stream-ready', (event) => {
      // Audio-only per the SDK - attach the remote stream's audio to the
      // big view's video element so it's at least audible during the
      // call (there is no remote video track to show for WhatsApp).
      const remoteVid = $('socialRemoteVideo');
      if (remoteVid && event.detail?.stream) remoteVid.srcObject = event.detail.stream;
    });

    // With RVC conversion on, the SDK's getUserMedia({audio:true}) call inside
    // startAudioBridge() is answered with the converted-voice track, so the
    // audio this call transmits is the converted voice (see
    // VoiceConversionPlayout.interceptMicrophone for why that is the only
    // hook the SDK offers - its RTCPeerConnection is private).
    let restoreMic = null;
    if (voiceConversion) {
      await VoiceConversionPlayout.start();
      // Only hijack if converted audio is genuinely arriving. Handing the SDK
      // a silent track would leave the call mute, and a mute is much worse
      // than falling back to the real microphone.
      const gotConvertedAudio = await VoiceConversionPlayout.waitForAudio(5000);
      if (gotConvertedAudio) {
        restoreMic = VoiceConversionPlayout.interceptMicrophone();
      } else {
        console.warn('[VoiceConversion] no converted audio arrived in time - sending the real microphone instead');
        LucyVoice.error = 'No converted audio arrived - using your own voice';
        LucyVoice.renderVoiceUi();
        LucyVoice.renderCallBadge();
      }
    }

    try {
      await gaCalls.startAudioBridge();
    } finally {
      // Undone immediately: nothing else on this page should ever be handed
      // the converted track when it asks for the microphone.
      if (restoreMic) restoreMic();
    }
    await gaClient.dial(target);
  }

  function endGreenApiCall(){
    if (gaClient) { gaClient.hangUp().catch(()=>{}); }
    gaClient = null;
    gaCalls = null;
  }

  // -------------------------------------------------------------
  // WaCalls engine UI - engine tabs, session state and pairing. Everything
  // goes through server.mjs's /api/social-call/wacalls/* routes; the WaCalls
  // API key and the WhatsApp session stay on the server side (WaCalls owns the
  // session - this app only drives it). The page never sees a credential, only
  // connection state, the linked number and a QR image.
  // -------------------------------------------------------------
  function renderWaEngineUi(){
    const engine = waEngine();
    const green = $('waEngineGreenBtn'), wc = $('waEngineWaCallsBtn');
    if (green) green.classList.toggle('active', engine === 'greenapi');
    if (wc) wc.classList.toggle('active', engine === 'wacalls');
    const hint = $('waEngineHint');
    if (hint) hint.textContent = WA_ENGINES[engine].hint;

    // The session box belongs to WaCalls only: WaCalls owns its WhatsApp
    // session on its own machine, while Green API is a per-user REST account
    // that links by QR with nothing of ours stored server-side.
    const sessionBox = $('waSessionBox');
    if (sessionBox) sessionBox.style.display = engine === 'wacalls' ? 'block' : 'none';
    const qrBox = $('waQrBox');
    if (qrBox) qrBox.style.display = 'block';

    // Prep-screen summary (WhatsApp calls only).
    const card = $('prepEngineCard');
    if (card) card.style.display = currentSocialPlatform === 'whatsapp' ? 'flex' : 'none';
    const val = $('prepEngineValue');
    if (val) val.textContent = waEngineLabel(engine);
    const prepHint = $('prepEngineHint');
    if (prepHint) {
      prepHint.textContent = engine === 'wacalls'
        ? 'Real WhatsApp video call — outgoing video is the avatar selected below'
        : 'Audio-only call via the Green API calls SDK';
    }
  }

  // Switching tabs must drop whatever QR is currently painted - it belongs
  // to the OTHER engine's session and was otherwise left on screen (and its
  // <img> src still pointing at the old engine's data URL) until this fired.
  function resetWaQrImage(){
    const img = $('waQrImg'), load = $('waQrLoading');
    if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
    if (load) { load.style.display = 'block'; load.textContent = 'Generating QR code…'; }
  }
  $('waEngineGreenBtn')?.addEventListener('click', () => {
    setWaEngine('greenapi');
    resetWaQrImage();
    refreshWaQr();
    fetchConnectedStatus();
  });
  $('waEngineWaCallsBtn')?.addEventListener('click', () => {
    setWaEngine('wacalls');
    resetWaQrImage();
    refreshWaQr();
    fetchWaCallsStatus();
  });
  $('prepEngineSwitchBtn')?.addEventListener('click', () => {
    setWaEngine(waEngine() === 'greenapi' ? 'wacalls' : 'greenapi');
  });

  // WaCalls connection status. Separate from fetchConnectedStatus() so a user
  // on Green API never triggers a request to a WaCalls instance they are not
  // using (and so an unconfigured or unreachable instance shows as its own
  // honest error instead of "not connected" on an engine that is not in play).
  //
  // Everything shown here is real state from the instance: which session this
  // app drives, whether that session is linked and as what number, and whether
  // the instance can carry video at all (a cached capability probe - see
  // probeVideoSupport() in server/wacalls.mjs). Nothing is inferred here.
  // The capability probe is a round trip, so it is not repeated on every 3s
  // poll: ask for it while the answer is still unknown (first load, or a
  // rebuild that changed the instance), otherwise only on demand.
  let waVideoStateKnown = null;
  async function fetchWaCallsStatus({ probe = false } = {}){
    const useProbe = probe || waVideoStateKnown === null || waVideoStateKnown === 'unknown';
    const detail = $('waDetailStatus'), sub = $('waDetailSub');
    const renderSession = (status) => {
      const idEl = $('waSessionId'), videoEl = $('waSessionVideo'), hintEl = $('waSessionHint');
      if (idEl) idEl.textContent = status?.sessionId || '—';
      if (videoEl) {
        const state = status?.video?.state;
        videoEl.textContent = state === 'video' ? 'supported'
          : state === 'audio-only' ? 'audio-only build'
          : state === 'unknown' ? 'not checked yet'
          : '—';
        videoEl.style.color = state === 'video' ? '#25D366' : (state === 'audio-only' ? '#ffb020' : '#fff');
      }
      if (hintEl) hintEl.textContent = status?.error || '';
      // The QR box is only meaningful while an unlinked session is waiting.
      const qrBox = $('waQrBox');
      if (qrBox) qrBox.style.display = (status?.configured && !status?.paired) ? 'block' : 'none';
    };

    const statusEl = $('whatsappAccountStatus');
    const badgeEl = $('whatsappAccountBadge');
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + `/api/social-call/wacalls/status${useProbe ? '?probe=1' : ''}`);
      const data = await res.json().catch(() => ({}));
      waVideoStateKnown = data?.video?.state ?? waVideoStateKnown;
      renderSession(data);

      // A paired WaCalls session means incoming WhatsApp calls can arrive at
      // any moment, so keep the control socket open while this engine is the
      // selected one.
      SocialCallMediaAdapter.watchEvents(!!(data.configured && data.paired));

      if (data.configured && data.paired) {
        const phone = data.phone ? '+' + data.phone : (data.jid || 'WhatsApp');
        if (statusEl) statusEl.textContent = `Connected as ${phone} (WaCalls)`;
        if (badgeEl) { badgeEl.textContent = 'Connected'; badgeEl.classList.add('connected'); }
        if (detail) detail.textContent = 'Connected';
        if (sub) {
          sub.textContent = `${phone} · WaCalls · ${data.video?.state === 'audio-only'
            ? 'audio-only build (no video routes)'
            : 'audio + video calling'}`;
        }
        $('waConnectedNumber').textContent = phone;
        $('waConnectedPushName').textContent = data.video?.state === 'audio-only'
          ? 'Ready for outgoing audio calls (this instance cannot send video)'
          : 'Ready for outgoing audio + video calls';
        $('waNotConnectedView').style.display = 'none';
        $('waConnectedView').style.display = 'block';
        const choiceSub = $('choiceWhatsAppSubtitle');
        if (choiceSub) choiceSub.textContent = `Connected (${phone}) — video ready`;
        return data;
      }

      if (statusEl) statusEl.textContent = data.configured ? 'Not connected (WaCalls)' : 'WaCalls not configured';
      if (badgeEl) { badgeEl.textContent = 'Connect'; badgeEl.classList.remove('connected'); }
      if (detail) detail.textContent = data.state === 'qr' ? 'Waiting for a scan…'
        : data.state === 'open' ? 'Connected'
        : data.state === 'unreachable' ? 'WaCalls unreachable'
        : data.state === 'not_configured' ? 'Server not configured'
        : 'Disconnected';
      if (sub) sub.textContent = data.error || 'Link the WaCalls session with the QR below (or press “Start pairing”).';
      $('waNotConnectedView').style.display = 'block';
      $('waConnectedView').style.display = 'none';
      const choiceSub = $('choiceWhatsAppSubtitle');
      if (choiceSub && data.configured) choiceSub.textContent = 'WaCalls — not linked yet';
      return data;
    } catch(e){
      if (detail) detail.textContent = 'WaCalls unavailable';
      if (sub) sub.textContent = e.message;
      renderSession(null);
      return null;
    }
  }

  // WaCalls session controls. Pairing is driven server-side (the API key stays
  // there); the QR arrives over WaCalls' event stream and is rendered by
  // /wacalls/qr, so the same box the Green API QR uses shows it.
  $('waSessionPairBtn')?.addEventListener('click', async () => {
    const hint = $('waSessionHint');
    const btn = $('waSessionPairBtn');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/pair', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      if (hint) hint.textContent = 'Pairing started — the QR appears below. Scan it in WhatsApp > Linked Devices.';
      setTimeout(() => refreshWaQr(), 1500);
      setTimeout(() => fetchWaCallsStatus({ probe: true }), 5000);
    } catch(e){
      if (hint) hint.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start pairing (show QR)';
    }
  });

  $('waPhonePairBtn')?.addEventListener('click', async () => {
    const hint = $('waSessionHint'), btn = $('waPhonePairBtn'), out = $('waPhoneCode');
    // Country code and number are separate fields. Strip everything that is
    // not a digit, and drop the leading 0 people type from their local format
    // (0907... -> 907...) so the combined number is a valid international one.
    const rawNum = ($('waPhoneInput')?.value || '').trim();
    const cc = ($('waPhoneCC')?.value || '').replace(/\D/g, '');
    let national = rawNum.replace(/\D/g, '').replace(/^0+/, '');
    // If they pasted a full +international number into the number box, trust it as is.
    const phone = rawNum.startsWith('+') ? rawNum.replace(/\D/g, '') : cc + national;
    if (!rawNum.startsWith('+') && !cc) { if (hint) hint.textContent = 'Enter your country code first (e.g. 234).'; return; }
    if (national.length < 6 && !rawNum.startsWith('+')) { if (hint) hint.textContent = 'Enter your phone number after the country code.'; return; }
    if (phone.length < 8) { if (hint) hint.textContent = 'That number looks too short.'; return; }
    btn.disabled = true;
    btn.textContent = 'Getting code…';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/pair-phone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error || !data.code) throw new Error(data.error || `HTTP ${res.status}`);
      const c = String(data.code);
      if (out) { out.textContent = c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c; out.style.display = 'block'; }
      if (hint) hint.textContent = 'In WhatsApp: Settings > Linked Devices > Link a Device > Link with phone number instead, then type this code.';
      setTimeout(() => fetchWaCallsStatus({ probe: true }), 20000);
    } catch(e){
      if (hint) hint.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Link with phone number (get code)';
    }
  });

  $('waSessionLogoutBtn')?.addEventListener('click', async () => {
    const hint = $('waSessionHint');
    if (!confirm('Unlink this WhatsApp account from the WaCalls session?')) return;
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/wacalls/logout', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      if (hint) hint.textContent = 'Session unlinked. Press “Start pairing” to link a number again.';
      resetWaQrImage();
    } catch(e){
      if (hint) hint.textContent = e.message;
    }
    await fetchWaCallsStatus();
  });

  // Bumped on every attempt and by endSocialCall(): a setup that finds its own
  // number is no longer current was cancelled (End pressed, or a newer attempt)
  // and must stop quietly instead of carrying on to place a call.
  let callAttemptSeq = 0;
  // Set by placeSocialCall() for a WaCalls avatar call: runs once, when the
  // callee actually picks up. The avatar is NOT started before that, so it
  // cannot talk into a ringing phone or burn an avatar session on a call that
  // is never answered.
  let onCallAnswered = null;
  function fireCallAnswered(){
    if (!onCallAnswered) return;
    const f = onCallAnswered; onCallAnswered = null;
    try { f(); } catch(e) { console.warn('[call] answered-hook failed:', e.message); }
  }
  // ---- plan / concurrency limits ------------------------------------------
  function isPlanLimitError(e){
    return /concurrency|concurrent|upgrade your plan|plan limit|limit reached|quota|insufficient (credits|minutes)|out of (credits|minutes)/i.test(String((e && e.message) || e || ''));
  }
  function planLimitMessage(e){
    const raw = String((e && e.message) || e || '').slice(0, 120);
    const who = selectedCallSource === 'avatar' ? 'Anam' : 'Decart/Fal';
    return `${who} refused to start a session: "${raw}". This is the number of sessions open at the same time, not your minutes - `
      + `the plan allows only one, and another is still open (an earlier call that has not timed out yet, another tab or device, or the ${who} dashboard playground). `
      + `Close it or wait a minute, then try again.`;
  }

  // ---- avatar dropped mid-call --------------------------------------------
  let avatarRecoveries = 0, avatarRecovering = false;
  function anamCloseReason(code, details){
    const c = String(code || '').replace('CONNECTION_CLOSED_CODE_', '');
    const names = {
      NORMAL: 'session ended',
      MICROPHONE_PERMISSION_DENIED: 'audio input was refused',
      SIGNALLING_CLIENT_CONNECTION_FAILURE: 'could not reach Anam',
      WEBRTC_FAILURE: 'network connection to Anam failed',
      SERVER_CLOSED_CONNECTION: 'Anam ended the session',
    };
    const base = names[c] || c || 'unknown';
    const extra = details ? ' — ' + String(details).replace(/\s+/g, ' ').slice(0, 90) : '';
    return base + extra;
  }
  async function recoverAvatar(why){
    if (avatarRecovering) return;
    const setLbl = (t) => { const l = $('socialCallStatusLabel'); if (l) l.textContent = t; };
    if (avatarRecoveries >= 1) { showCallFailureAndEnd('Avatar disconnected: ' + why); return; }
    avatarRecoveries++; avatarRecovering = true;
    setLbl('Avatar disconnected (' + why + ') — reconnecting…');
    try {
      try { SocialAnamSource.stop(); } catch(e){}
      await new Promise(r => setTimeout(r, 800));
      if (!$('socialCallScreen')?.classList.contains('active')) return;
      await withTimeout(SocialAnamSource.start(), 30000, 'Restarting the avatar');
      const voice = await waitForAvatarAudio(8000);
      if (voice) WaCallsMediaLeg.attachOutgoingAudio(voice);
      if (avatarGateActive && avatarGreeted) {
        SocialAnamSource.notifyCallConnected('', '[CALL EVENT] You dropped off the line for a moment and are back on the same live call. Carry on naturally from where you were. Do not mention the interruption.');
      }
      setLbl('Connected');
    } catch(e) {
      showCallFailureAndEnd('Avatar disconnected: ' + why + ' — restart failed: ' + (e && e.message || e));
    } finally {
      avatarRecovering = false;
    }
  }
  async function waitForAvatarAudio(ms){
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const a = SocialAnamSource.getAudioStream();
      if (a) return a;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  function withTimeout(promise, ms, label){
    let t;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  async function placeSocialCall(){
    const prepBtn = $('prepStartCallActionBtn');
    prepBtn.disabled = true;
    prepBtn.textContent = 'Starting Lucy 2.5 & Calling…';
    $('prepErrorHint').textContent = '';

    const attempt = ++callAttemptSeq;
    avatarRecoveries = 0; avatarRecovering = false;
    const cancelled = () => attempt !== callAttemptSeq;
    const setStatus = (text) => { const l = $('socialCallStatusLabel'); if (l && !cancelled()) l.textContent = text; };
    let callScreenShown = false;
    // WhatsApp through WaCalls with an Anam avatar: nothing from the caller's
    // own devices is used. The avatar listens to the callee and speaks to them.
    const avatarOnWaCalls = selectedCallSource === 'avatar' && currentSocialPlatform === 'whatsapp' && waEngine() === 'wacalls';

    try {
      if (avatarOnWaCalls) CalleeAudioBus.start(); // inside the tap, so the audio context is allowed to run
      resetAvatarGate(avatarOnWaCalls);
      if (!avatarOnWaCalls && !socialMicStream) {
        try {
          socialMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          $('prepMicStatus').textContent = 'Microphone: Active';
        } catch(e) {
          $('prepErrorHint').textContent = 'Microphone permission required for call';
          prepBtn.disabled = false;
          prepBtn.textContent = 'Place Call';
          return;
        }
      }
      if (cancelled()) return;

      // Which WhatsApp engine carries this call. Captured NOW rather than
      // read again at hangup, so switching engines mid-call can't send the
      // teardown to the wrong backend.
      currentCallEngine = currentSocialPlatform === 'whatsapp' ? waEngine() : null;
      setSocialCallContext('outgoing', currentSocialPlatform, selectedSocialContact && (selectedSocialContact.name || ''));

      // The call screen (with its End button) comes up FIRST, before anything
      // slow. It used to appear only after the avatar had started, the call
      // was placed and the media leg had negotiated - so any stall in those
      // left the avatar running behind a prep modal with no way to hang up.
      const platformLabel = currentSocialPlatform === 'whatsapp'
        ? `WhatsApp${currentCallEngine === 'wacalls' ? ' · WaCalls' : ''}`
        : 'Telegram';
      showSocialCallScreen({
        name: selectedSocialContact.name || selectedSocialContact.target,
        label: platformLabel,
        status: 'Starting avatar…',
      });
      callScreenShown = true;
      if (selectedCallSource === 'avatar') loadAnamSdk().catch(() => {}); // warm up while it rings

      // Activate whichever outgoing source was picked - Lucy 2.5 (live face
      // swap of your own camera) or an Anam AI avatar.
      const startAvatar = async () => {
        const startedAvatarAt = Date.now();
        setStatus('Starting avatar…');
        // Only one call runs at a time, so any Anam session that is still open now is a leftover from an
        // earlier call (page closed, crash, hang-up). Clear them first instead of letting the first
        // attempt run into the concurrency limit.
        if (selectedCallSource === 'avatar' && !state.testAvatar) {
          const pre = await Promise.race([stopAnamSessions(), new Promise((r) => setTimeout(() => r(null), 5000))]);
          if (cancelled()) return;
          if (pre && pre.found) await new Promise((r) => setTimeout(r, 1200)); // let Anam register the stop
        }
        const tick = setInterval(() => {
          if (cancelled()) { clearInterval(tick); return; }
          const l = $('socialCallStatusLabel');
          if (l && /^Starting avatar/.test(l.textContent)) l.textContent = `Starting avatar… ${Math.round((Date.now() - startedAvatarAt) / 1000)}s`;
        }, 1000);
        try {
        // Up to 3 tries. A concurrency error usually means the previous session (this call's own
        // failed first try, or the last call) is still closing on Anam's side: wait longer, then retry.
        let lastErr = null, emptyStops = 0;
        for (let i = 0; i < 3; i++) {
          try {
            await withTimeout(activeSocialSource().start({ forSocialCall: true }), i === 0 ? 40000 : 40000, 'Starting the avatar');
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (cancelled()) return;
            console.warn(`[avatar] start attempt ${i + 1} failed:`, err && err.message);
            setStatus(`Avatar attempt ${i + 1} failed: ${(err && err.message || err)}`.slice(0, 140));
            try { activeSocialSource().stop(); } catch(e){}
            if (i === 2) break;
            const limit = isPlanLimitError(err);
            if (limit && selectedCallSource !== 'avatar') break;
            if (limit) {
              const freed = await Promise.race([stopAnamSessions(), new Promise(r => setTimeout(() => r(null), 6000))]);
              // Anam says the limit is reached yet shows no running session to stop, twice in a
              // row: waiting longer will not help. Say so now instead of holding the call open.
              if (freed && freed.found === 0 && ++emptyStops >= 2) {
                throw new Error('Anam reports its session limit is reached, but no session is running on this account to stop. '
                  + 'Check Anam > Sessions for one still open (another device, or the dashboard playground), or the limit is your plan itself.');
              }
            }
            if (cancelled()) return;
            setStatus(limit ? 'Waiting for the previous avatar session to close…' : 'Restarting the avatar…');
            await new Promise(r => setTimeout(r, limit ? 4000 : 300));
            if (cancelled()) return;
          }
        }
        if (lastErr) throw (isPlanLimitError(lastErr) ? new Error(planLimitMessage(lastErr)) : lastErr);
        if (cancelled()) { try { activeSocialSource().stop(); } catch(e){} return; }
        if (avatarOnWaCalls) {
          const voice = await waitForAvatarAudio(30000);
          if (cancelled()) return;
          if (voice) WaCallsMediaLeg.attachOutgoingAudio(voice);
          else console.warn('[WaCalls] the avatar produced no audio track - the callee will not hear it');
          avatarReadyForGreeting = true; scheduleAvatarGreeting();
        }
        } finally { clearInterval(tick); }
      };
      // The avatar gets a head start so it is normally up BEFORE the callee
      // picks up (it stays silent until they speak - skipGreeting). If it fails
      // within the grace period (plan limit, bad key...) nothing is dialled and
      // the real reason is shown. If it is just slow, the phone rings anyway and
      // the avatar attaches as soon as it is ready - waiting on it used to mean
      // no ring at all for as long as it took (or until it failed).
      resetTrace();
      trace('call started (' + (selectedCallSource === 'avatar' ? 'avatar' : 'Lucy') + ')');
      const avatarPromise = startAvatar().then(
        () => { trace('avatar: ready'); },
        (e) => { trace('avatar: FAILED - ' + (e && e.message || e)); throw e; }
      );
      avatarPromise.catch(() => {}); // handled below
      let avatarState = 'pending';
      await Promise.race([
        avatarPromise.then(() => { avatarState = 'ready'; }), // a rejection throws -> caught below, nothing placed
        new Promise((r) => setTimeout(r, 16000)),
      ]);
      if (cancelled()) return;
      if (avatarState === 'pending') {
        avatarPromise.then(() => {}, (e) => {
          if (!cancelled()) showCallFailureAndEnd('Avatar failed: ' + (e && e.message || e));
        });
      }

      setStatus('Calling…');
      trace('placing the call');
      // Place call on backend bridge
      const ctl = new AbortController();
      const placeTimer = setTimeout(() => ctl.abort(), 55000); // longer than the server's own 40s wait
      let res;
      try {
        res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctl.signal,
          body: JSON.stringify({
            platform: currentSocialPlatform,
            target: selectedSocialContact.target,
            name: selectedSocialContact.name,
            // Explicit provider selection. Omitted for Telegram; for WhatsApp
            // 'greenapi' reproduces exactly the previous behaviour.
            provider: currentCallEngine || undefined,
            video: true,
            // Which avatar is feeding the outgoing video - recorded by the
            // bridge for the call record.
            source: selectedCallSource === 'avatar' ? 'anam' : 'lucy',
          }),
        });
      } catch (e) {
        throw new Error(e.name === 'AbortError' ? 'Placing the call timed out after 55s - the server may be waking up, try again' : e.message);
      } finally { clearTimeout(placeTimer); }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to place call');
      if (cancelled()) {
        // End was pressed while the request was in flight: the call may now
        // exist on the server, so make sure it is torn down there too.
        try { await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/hangup', { method: 'POST' }); } catch(e){}
        return;
      }

      // Realtime RVC conversion of the outgoing Lucy 2.5 audio - Lucy source
      // only, and only if the backend can actually convert.
      const useVoiceConversion = selectedCallSource === 'lucy' && LucyVoice.enabled && LucyVoice.canEnable();
      if (useVoiceConversion) {
        await LucyVoice.startForCall(currentSocialPlatform);
        if (currentSocialPlatform === 'whatsapp') await VoiceConversionPlayout.start();
      }

      if (currentSocialPlatform === 'whatsapp' && currentCallEngine === 'greenapi') {
        // Actual ringing happens here, client-side - the backend POST
        // above only recorded call state/history.
        await startGreenApiCall(selectedSocialContact.target, { voiceConversion: useVoiceConversion });
      }
      if (currentSocialPlatform === 'whatsapp' && currentCallEngine === 'wacalls') {
        // The REAL call was already placed by WaCalls. What remains is this
        // browser's own media leg to the WaCalls server. The phone is already
        // ringing by now, so say so while the leg negotiates.
        setStatus('Ringing…');
        await withTimeout(WaCallsMediaLeg.open({
          callId: data.call.callId,
          video: data.call.videoRequested !== false,
          source: selectedCallSource === 'avatar' ? 'anam' : 'lucy',
          voiceConversion: useVoiceConversion,
        }), 30000, 'Connecting call media');
        if (cancelled()) return;
        console.log(`[WaCalls] outgoing call ${data.call.callId} ready (avatar=${selectedCallSource === 'avatar' ? 'Anam' : 'Lucy 2.5'})`);
      }

      // Start streaming outgoing video frames & live audio through adapter.
      SocialCallMediaAdapter.startStreaming(avatarOnWaCalls ? null : activeSocialSource().getStream(), socialMicStream, {
        voiceConversion: useVoiceConversion,
        // WaCalls has its own media plane (see WaCallsMediaLeg); this socket
        // stays for the event stream and the RVC return path only.
        waCalls: currentCallEngine === 'wacalls',
      });

    } catch(err) {
      if (cancelled()) return; // End was pressed: endSocialCall() already cleaned up
      console.error('[placeSocialCall] error:', err);
      // Tear down everything this attempt started, hide the call screen again
      // and put the real reason back on the prep modal where it can be read.
      try { WaCallsMediaLeg.close(); } catch(e){}
      try { SocialCallMediaAdapter.stop(); } catch(e){}
      try { LiveSwapMediaSource.stop(); } catch(e){}
      try { SocialAnamSource.stop(); } catch(e){}
      try { PeerMediaPlayout.stop(); } catch(e){}
      try { LucyVoice.stopForCall(); VoiceConversionPlayout.stop(); } catch(e){}
      onCallAnswered = null;
      try { CalleeAudioBus.stop(); } catch(e){}
      currentCallEngine = null;
      callAttemptSeq++;
      clearInterval(socialCallDurationTimer); socialCallDurationTimer = null;
      stopRingback();
      if (callScreenShown) {
        $('socialCallScreen').classList.remove('active');
        $('callPrepModal').classList.add('active');
      }
      $('prepErrorHint').textContent = err.message || 'Error starting call';
      try { await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/hangup', { method: 'POST' }); } catch(e){}
    } finally {
      prepBtn.disabled = false;
      prepBtn.textContent = 'Place Call';
    }
  }

  // Active Social Call controls
  $('socialMuteBtn')?.addEventListener('click', () => {
    socialMuted = !socialMuted;
    if (socialMicStream) {
      socialMicStream.getAudioTracks().forEach(t => t.enabled = !socialMuted);
    }
    // On WaCalls the outgoing audio is this page's own data channel, so mute
    // is applied here: the leg keeps sending (digital silence) so the peer's
    // stream does not break up, but nothing from the room goes out. Green API
    // mutes its own outgoing track above, unchanged.
    if (currentCallEngine === 'wacalls') {
      WaCallsMediaLeg.setMuted(socialMuted);
    }
    $('socialMuteBtn').classList.toggle('muted', socialMuted);
    $('socialMuteBtn').innerHTML = socialMuted
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M3 3l18 18"/><path d="M12 1a3 3 0 0 0-3 3v6.5M15 9V4a3 3 0 0 0-3-3"/><path d="M19 10v2a7 7 0 0 1-9.8 6.4M5 10v2a7 7 0 0 0 2 4.9"/><path d="M12 19v4"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/></svg>';
  });

  $('socialEndBtn')?.addEventListener('click', endSocialCall);

  // -------------------------------------------------------------
  // Social call layout: PIP (tap the small self-view to swap it with the
  // big view, drag it anywhere) or split-screen (two fixed equal panes).
  // Both replace the idea of a separate "flip" button - self-view and the
  // outgoing view are always visible together, in one arrangement or
  // the other.
  // -------------------------------------------------------------
  (function setupSocialCallLayout(){
    const screen = $('socialCallScreen');
    const videoA = $('socialRemoteVideo'), videoB = $('socialSelfVideo');
    if (!screen || !videoA || !videoB) return;

    $('socialLayoutToggleBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      screen.dataset.layout = screen.dataset.layout === 'split' ? 'pip' : 'split';
      // Clear any inline position from a previous PIP drag - split mode's
      // CSS (top:0/bottom:0/left:0/right:0) is overridden by leftover
      // inline styles otherwise, since inline style always beats a
      // stylesheet rule regardless of selector. This was the split-screen
      // layout bug: switching modes after ever dragging the thumb left it
      // stuck at its dragged position instead of snapping to a full half.
      [videoA, videoB].forEach((el) => {
        el.style.left = ''; el.style.top = ''; el.style.right = '';
      });
    });

    // Tap-to-swap which video is "main" (big) vs "thumb" (small PIP), and
    // drag-to-reposition the thumb - both only meaningful in PIP mode.
    // Handlers are on both elements since either can be the thumb after a
    // swap; each checks its own current role at pointerdown time.
    let dragEl = null, moved = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function onPointerDown(e){
      const el = e.currentTarget;
      if (screen.dataset.layout !== 'pip' || !el.classList.contains('socialPipThumb')) return;
      dragEl = el; moved = false;
      el.classList.add('dragging');
      const rect = el.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      el.style.right = 'auto';
      el.setPointerCapture?.(e.pointerId);
    }
    function onPointerMove(e){
      if (!dragEl || dragEl !== e.currentTarget) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const rect = dragEl.getBoundingClientRect();
      const maxLeft = screen.clientWidth - rect.width;
      const maxTop = screen.clientHeight - rect.height;
      dragEl.style.left = `${Math.min(Math.max(0, startLeft + dx), maxLeft)}px`;
      dragEl.style.top = `${Math.min(Math.max(0, startTop + dy), maxTop)}px`;
    }
    function onPointerUp(e){
      const el = e.currentTarget;
      if (!dragEl || dragEl !== el) return;
      dragEl = null;
      el.classList.remove('dragging');
      if (!moved) {
        // A real tap, not a drag - swap main/thumb roles.
        const main = screen.querySelector('.socialPipMain');
        if (main && main !== el) {
          main.classList.remove('socialPipMain'); main.classList.add('socialPipThumb');
          el.classList.remove('socialPipThumb'); el.classList.add('socialPipMain');
          // Reset the now-thumb element back to its default corner position.
          main.style.left = ''; main.style.top = ''; main.style.right = '16px';
          el.style.left = ''; el.style.top = ''; el.style.right = '';
        }
      }
    }
    // Tap anywhere on the video (not on a button, the small thumb or the
    // incoming banner) to hide / show the top bar and the bottom controls.
    screen.addEventListener('click', (e) => {
      if (e.target.closest('#socialCallTop, #socialCallBottom, .socialPipThumb, #socialIncomingBanner')) return;
      $('socialCallTop')?.classList.toggle('hidden');
      $('socialCallBottom')?.classList.toggle('hidden');
    });

    [videoA, videoB].forEach((el) => {
      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('pointermove', onPointerMove);
      el.addEventListener('pointerup', onPointerUp);
      el.addEventListener('pointercancel', onPointerUp);
    });
  })();

  // ---- WhatsApp avatar call -> summary --------------------------------------
  // The in-app avatar call already sent a summary push when it ended; WhatsApp avatar calls
  // never did. Taken at the very top of endSocialCall (before anything is torn down).
  let waSummaryKey = 0;
  function captureWaAvatarCallForSummary(){
    if (currentSocialPlatform !== 'whatsapp' || currentCallEngine !== 'wacalls' || selectedCallSource !== 'avatar') return null;
    if (!$('socialCallScreen')?.classList.contains('active')) return null; // already ended / nothing to summarise
    const key = socialCallStartedAt || Date.now();
    if (waSummaryKey === key && socialCallStartedAt) return null; // one summary per call
    const answered = !!socialCallDurationTimer;
    const reason = String(lastEndReason || '');
    // A call that never connected only deserves a note if the other side didn't pick up;
    // if WE failed (avatar/server error) the failure banner already says so.
    if (!answered && !/declin|no answer|nobody|busy|didn.t/i.test(reason)) return null;
    waSummaryKey = key;
    return {
      callee: (selectedSocialContact && (selectedSocialContact.name || selectedSocialContact.target)) || '',
      answered,
      durationSec: answered ? Math.max(0, Math.round((Date.now() - socialCallStartedAt) / 1000)) : 0,
      transcript: (SocialAnamSource.transcript || []).slice(-200),
    };
  }
  async function sendWaCallSummary(job){
    if (!job || !currentUser) return;
    try {
      const mins = job.durationSec >= 60 ? `${Math.floor(job.durationSec / 60)}m ${job.durationSec % 60}s` : `${job.durationSec}s`;
      const label = job.answered ? `WhatsApp call with ${job.callee || 'contact'} (${mins})` : `WhatsApp call to ${job.callee || 'contact'} - not answered`;
      const historyId = await addHistory({ provider: 'anam', summary: label });
      trace('summary: requested' + (historyId ? '' : ' (no history row)'));
      if (!historyId) return;
      const body = JSON.stringify({ historyId, platform: 'whatsapp', callee: job.callee, answered: job.answered, durationSec: job.durationSec, transcript: job.transcript });
      await fetch('/api/call-summary', {
        method: 'POST', keepalive: body.length < 60000,
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body,
      });
    } catch (e) { console.error('WhatsApp call-summary request failed:', e); }
  }

  async function endSocialCall(){
    callAttemptSeq++; // cancels a placeSocialCall() that is still setting up
    trace('call screen closed');
    resetAvatarGate(false);
    const waSummaryJob = captureWaAvatarCallForSummary();
    if (lastEndReason) { showEndToast(lastEndReason); lastEndReason = ''; }
    if (waSummaryJob) sendWaCallSummary(waSummaryJob); // fire-and-forget: the push is what reaches you
    clearInterval(socialCallDurationTimer); socialCallDurationTimer = null;
    stopRingback();
    socialCallContext = null;
    // Only the engine that carried THIS call is torn down: Green API's browser
    // client hangs up client-side, WaCalls ends the call server-side through
    // /api/social-call/hangup further down (which deletes it on WaCalls).
    if (currentSocialPlatform === 'whatsapp' && currentCallEngine === 'greenapi') endGreenApiCall();
    $('socialCallScreen').classList.remove('active');
    $('socialCallTop')?.classList.remove('hidden');
    $('socialCallBottom')?.classList.remove('hidden');

    // Stop converting audio for this call BEFORE closing the media socket,
    // so the stop goes out on the live connection instead of re-opening one
    // just to say goodbye. The converter keeps an RVC model resident, so it
    // must not outlive the call it was started for.
    LucyVoice.stopForCall();
    VoiceConversionPlayout.stop();
    // Tear down media pipelines. The WaCalls leg goes first: it owns the data
    // channels that carry this call's media, and closing it stops the encoder
    // before the avatar sources below are stopped underneath it.
    WaCallsMediaLeg.close();
    hideIncomingWaCallsCall();
    SocialCallMediaAdapter.stop();
    LiveSwapMediaSource.stop();
    SocialAnamSource.stop();
    PeerMediaPlayout.stop();
    onCallAnswered = null;
    CalleeAudioBus.stop();
    currentCallEngine = null;

    if (socialMicStream) {
      socialMicStream.getTracks().forEach(t => t.stop());
      socialMicStream = null;
    }

    try {
      const hc = new AbortController();
      const ht = setTimeout(() => hc.abort(), 6000); // never let the hangup request hang the cleanup
      await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/hangup', { method: 'POST', signal: hc.signal });
      clearTimeout(ht);
    } catch(e){}

    // Update Recent calls list with new record
    renderRecent();
  }

  // Closing/reloading the page mid-call must not leave a live avatar session
  // behind: on a plan with one concurrent session that blocks the next call.
  window.addEventListener('pagehide', () => {
    try { SocialAnamSource.stop(); } catch(e){}
    try { if (anamClient) anamClient.stopStreaming(); } catch(e){}
  });

  // Initial fetch of connected account statuses, and make both avatar-source
  // selectors agree with the stored/default choice before anything is shown.
  syncAvatarSourceUi();
  fetchConnectedStatus();

  // ---------- auth ----------
  const authScreen = $('authScreen');
  let authMode = 'signin';

  $('authToggleMode')?.addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    $('authSubmit').textContent = authMode === 'signin' ? 'Sign in' : 'Sign up';
    $('authToggleMode').innerHTML = authMode === 'signin' ? 'Need an account? <b>Sign up</b>' : 'Have an account? <b>Sign in</b>';
    $('authHint').textContent = '';
  });

  $('authSubmit')?.addEventListener('click', async () => {
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    if (!email || !password) { $('authHint').textContent = 'Enter an email and password.'; return; }
    $('authHint').textContent = 'Working…';
    const { error } = authMode === 'signin'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    if (error) { $('authHint').textContent = error.message; return; }
    if (authMode === 'signup') { $('authHint').textContent = 'Check your email to confirm, then wait for approval.'; }
  });

  $('googleSignIn')?.addEventListener('click', async () => {
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
  });

  $('signOutBtn')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
  });
  $('pendingSignOut')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
  });

  async function checkApproval(userId){
    const { data } = await supabase.from('user_approvals').select('approved').eq('user_id', userId).maybeSingle();
    return !!data?.approved;
  }

  async function enterApp(user){
    currentUser = user;
    // Google accounts have no password to change — only show this for email/password sign-ups.
    const provider = user.app_metadata?.provider || user.identities?.[0]?.provider || 'email';
    $('openChangePassword').style.display = provider === 'email' ? 'flex' : 'none';
    const approved = await checkApproval(user.id);
    if (!approved) {
      authScreen.classList.remove('hidden');
      $('authBoot').style.display = 'none';
      $('authBox').style.display = 'none';
      $('pendingBox').style.display = 'block';
      splashAuthDone = true; maybeHideSplash();
      try {
        const k = 'signupNotified:' + user.id;
        if (!localStorage.getItem(k)) {
          fetch('/api/save-push-subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
            body: JSON.stringify({ action: 'notify-signup' }),
          }).then(r => { if (r.ok) localStorage.setItem(k, '1'); }).catch(() => {});
        }
      } catch (_) {}
      return;
    }
    $('authBoot').style.display = 'none';
    $('authBox').style.display = '';
    $('pendingBox').style.display = 'none';
    authScreen.classList.add('hidden');
    await loadSettings();
    restoreLfReference();
    refreshHome(true);
    fetchConnectedStatus();
    loadAnamAvatars();
    loadAnamVoices();
    syncSavedContacts();
    splashAuthDone = true; maybeHideSplash();
  }

  // -------------------------------------------------------------
  // Home: credits, Avatar + Live Swap tiles, Connect accounts
  // -------------------------------------------------------------
  const avPhotoKey = () => `lc_avatar_photo:${currentUser?.id || 'anon'}`;
  const lfRefKey = () => `lc_lf_ref:${currentUser?.id || 'anon'}`;
  let anamAvatarList = [], lfRefThumb = '', lfReferencePath = '';

  function refreshHomeHeader(){
    const name = (state.displayName || '').trim();
    const first = name.split(/\s+/)[0] || '';
    const hello = $('homeHello');
    if (hello) hello.textContent = first ? `Hello, ${first}` : 'Hello';
    const img = $('homeProfileImg'), ini = $('homeProfileInitial');
    if (!img || !ini) return;
    ini.textContent = (first || currentUser?.email || '?').charAt(0).toUpperCase();
    if (state.avatarUrl) { img.src = state.avatarUrl; img.style.display = 'block'; }
    else { img.style.display = 'none'; }
  }

  // ---- Avatar tile: the Anam avatar (Anam's own render when it has one, else the photo that was uploaded)
  function localAvatarPhoto(){
    try {
      const v = JSON.parse(localStorage.getItem(avPhotoKey()) || 'null');
      if (v && v.id === state.anamAvatarId) return v.url || '';
    } catch(_){}
    return '';
  }
  function anamAvatarImage(){
    if (!state.anamAvatarId) return '';
    const hit = anamAvatarList.find(a => a.id === state.anamAvatarId);
    return (hit && hit.image_url) || localAvatarPhoto();
  }
  function setTileImage(img, src, fallbackSrc){
    if (!src) { img.removeAttribute('src'); img.style.display = 'none'; return false; }
    img.onerror = () => {
      if (fallbackSrc && img.src !== fallbackSrc) { img.src = fallbackSrc; return; }
      img.style.display = 'none';
    };
    if (img.getAttribute('src') !== src) img.src = src;
    img.style.display = 'block';
    return true;
  }
  function refreshHomeTiles(){
    const avImg = $('homeAvatarImg');
    if (!avImg) return;
    const src = anamAvatarImage();
    const has = setTileImage(avImg, src, localAvatarPhoto());
    $('homeAvatarEmpty').style.display = has ? 'none' : 'flex';
    $('homeAvatarEmpty').querySelector('span').textContent = state.anamAvatarId ? (state.anamAvatarName || 'Avatar ready') : 'Add photo';
    $('homeAvatarUpload').style.display = state.anamAvatarId ? 'flex' : 'none';
    const bg = $('homeHeroBg');
    if (bg) { bg.style.backgroundImage = has ? `url("${src}")` : ''; bg.classList.toggle('on', has); }

    const swImg = $('homeSwapImg');
    const swSrc = lfRefThumb || lfReferenceImageUrl;
    const swHas = setTileImage(swImg, swSrc, lfReferenceImageUrl);
    $('homeSwapEmpty').style.display = swHas ? 'none' : 'flex';
    $('homeSwapDelete').style.display = lfReferenceImageUrl ? 'flex' : 'none';
  }

  // Mirrors an existing upload's status line onto a tile caption.
  function mirrorStatus(srcId, busyId, ignore){
    const src = $(srcId), dst = $(busyId);
    if (!src || !dst) return;
    let t = null;
    new MutationObserver(() => {
      const txt = (src.textContent || '').trim();
      clearTimeout(t);
      if (!txt || (ignore && ignore.test(txt))) { dst.style.display = 'none'; return; }
      dst.textContent = txt.split(' (')[0]; // keep tile captions short
      dst.style.display = 'block';
      if (!/…$/.test(txt)) t = setTimeout(() => { dst.style.display = 'none'; }, 4000);
    }).observe(src, { childList: true, characterData: true, subtree: true });
  }
  mirrorStatus('avatarUploadStatus', 'homeAvatarBusy');
  mirrorStatus('lfImageStatus', 'homeSwapBusy', /^(Reference photo ready|Add a photo)/);
  function tileNote(busyId, text){
    const el = $(busyId);
    el.textContent = text; el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  const onTile = (el, fn) => {
    el?.addEventListener('click', fn);
    el?.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); fn(e); } });
  };
  function pickAvatarPhoto(){
    if (!state.anamKeySet) { tileNote('homeAvatarBusy', 'Add your Anam API key in Profile → API first.'); return; }
    $('avatarPhotoInput').click();
  }
  onTile($('homeAvatarTile'), () => {
    if (state.anamAvatarId) $('openAnamAvatarScreen').click();
    else pickAvatarPhoto();
  });
  $('homeAvatarUpload')?.addEventListener('click', (e) => { e.stopPropagation(); pickAvatarPhoto(); });

  // ---- Live Swap tile: reference photo kept on this device until the person removes it
  function makeThumb(file, max = 480){
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.82));
        } catch (_) { resolve(''); }
        URL.revokeObjectURL(url);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
      img.src = url;
    });
  }
  function saveLfRef(){
    try {
      localStorage.setItem(lfRefKey(), JSON.stringify({ url: lfReferenceImageUrl, desc: lfReferenceDescription, thumb: lfRefThumb, path: lfReferencePath }));
    } catch (_) {
      // quota: keep the URL, drop the thumbnail
      try { localStorage.setItem(lfRefKey(), JSON.stringify({ url: lfReferenceImageUrl, desc: lfReferenceDescription, thumb: '', path: lfReferencePath })); } catch (__) {}
    }
  }
  function restoreLfReference(){
    let v = null;
    try { v = JSON.parse(localStorage.getItem(lfRefKey()) || 'null'); } catch (_) {}
    if (!v || !v.url) { refreshHomeTiles(); return; }
    lfReferenceImageUrl = v.url;
    lfReferenceDescription = v.desc || '';
    lfRefThumb = v.thumb || '';
    lfReferencePath = v.path || '';
    const prev = $('lfImagePreview');
    if (prev) { prev.src = lfRefThumb || lfReferenceImageUrl; prev.style.display = 'block'; }
    const st = $('lfImageStatus');
    if (st) st.textContent = 'Reference photo ready';
    refreshHomeTiles();
  }
  async function clearLfReference(){
    if (!confirm('Remove your Live Swap photo?')) return;
    const path = lfReferencePath;
    lfReferenceImageUrl = ''; lfReferenceDescription = ''; lfRefThumb = ''; lfReferencePath = '';
    try { localStorage.removeItem(lfRefKey()); } catch (_) {}
    for (const id of ['lfImagePreview', 'prepLfImagePreview']) { const el = $(id); if (el) { el.removeAttribute('src'); el.style.display = 'none'; } }
    const st = $('lfImageStatus');
    if (st) st.textContent = 'Add a photo to swap yourself for it, or an outfit/product image';
    refreshHomeTiles();
    if (path) { try { await supabase.storage.from('user-uploads').remove([path]); } catch (_) {} }
  }
  onTile($('homeSwapTile'), () => {
    if (lfReferenceImageUrl) showTab('features');
    else $('lfImageInput').click();
  });
  $('homeSwapDelete')?.addEventListener('click', (e) => { e.stopPropagation(); clearLfReference(); });

  // ---- Credits: fal.ai balance, Anam, and WhatsApp minutes
  const credits = { at: 0, busy: false };
  function setCredit(key, value, sub, state_){
    const card = $('credit' + key);
    if (!card) return;
    $('credit' + key + 'Value').textContent = value;
    $('credit' + key + 'Sub').textContent = sub || '\u00a0';
    card.classList.remove('loading', 'warn');
    if (state_) card.classList.add(state_);
  }
  async function refreshCredits(force){
    if (!currentUser || credits.busy) return;
    if (!force && Date.now() - credits.at < 60000) return;
    credits.busy = true;
    ['Anam', 'Fal', 'Minutes'].forEach(k => $('credit' + k)?.classList.add('loading'));

    // Anam has no public balance endpoint yet, so this card reflects key status and links to the Lab.
    if (state.anamKeySet) setCredit('Anam', 'Linked', 'Tap to open Anam Lab');
    else setCredit('Anam', '—', 'Add your key', 'warn');

    const headers = { ...(await authHeader()) };
    const fal = (async () => {
      if (!state.falKeySet) { setCredit('Fal', '—', 'Add your key', 'warn'); return; }
      try {
        const r = await fetch('/api/keys?balance=fal', { headers });
        const d = await r.json();
        if (typeof d.balance === 'number') {
          const sym = (d.currency || 'USD') === 'USD' ? '$' : '';
          setCredit('Fal', `${sym}${d.balance.toFixed(2)}`, sym ? 'credit left' : (d.currency + ' left'));
        } else if (d.reason === 'needs_admin_key') setCredit('Fal', '—', 'Needs admin key', 'warn');
        else if (d.reason === 'not_set') setCredit('Fal', '—', 'Add your key', 'warn');
        else setCredit('Fal', '—', 'Unavailable', 'warn');
      } catch (_) { setCredit('Fal', '—', 'Unavailable', 'warn'); }
    })();
    const mins = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      try {
        const r = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/status', { headers, signal: ctl.signal });
        if (!r.ok) throw new Error('status ' + r.status);
        const a = (await r.json()).access;
        if (!a) throw new Error('no access info');
        if (a.unlimited) setCredit('Minutes', 'Unlimited', a.plan === 'pro' ? 'Pro plan' : 'Admin');
        else if (!a.allowed) setCredit('Minutes', '0', a.reason === 'locked' ? 'Locked' : 'Used up', 'warn');
        else {
          const n = Number(a.minutesRemaining || 0);
          setCredit('Minutes', String(Number.isInteger(n) ? n : n.toFixed(1)), 'min left');
        }
      } catch (_) { setCredit('Minutes', '—', 'Unavailable', 'warn'); }
      finally { clearTimeout(timer); }
    })();
    await Promise.all([fal, mins]);
    credits.at = Date.now();
    credits.busy = false;
  }
  $('refreshCreditsBtn')?.addEventListener('click', () => refreshCredits(true));
  $('creditAnam')?.addEventListener('click', () => {
    if (state.anamKeySet) window.open('https://lab.anam.ai', '_blank', 'noopener');
    else $('apiKeysScreen').classList.add('active');
  });
  $('creditFal')?.addEventListener('click', () => {
    if (!state.falKeySet) $('apiKeysScreen').classList.add('active');
    else if ($('creditFalSub').textContent === 'Needs admin key') window.open('https://fal.ai/dashboard/keys', '_blank', 'noopener');
    else refreshCredits(true);
  });
  $('creditMinutes')?.addEventListener('click', () => refreshCredits(true));

  // ---- Connect accounts page
  function openAccounts(){ $('accountsScreen').classList.add('active'); fetchConnectedStatus(); }
  $('homeOpenAccounts')?.addEventListener('click', openAccounts);
  $('profileOpenAccounts')?.addEventListener('click', openAccounts);
  $('closeAccounts')?.addEventListener('click', () => $('accountsScreen').classList.remove('active'));
  $('homeProfileBtn')?.addEventListener('click', () => showTab('profile'));

  function refreshHome(force){
    refreshHomeHeader();
    refreshHomeTiles();
    const wa = $('whatsappAccountBadge');
    const sum = $('homeAccountsSummary');
    if (sum) sum.textContent = wa && wa.classList.contains('connected') ? 'WhatsApp connected' : 'WhatsApp, Telegram';
    refreshCredits(!!force);
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      enterApp(session.user);
    } else {
      currentUser = null;
      try { SocialCallMediaAdapter.watchEvents(false); } catch(e){}
      $('authBoot').style.display = 'none';
      $('authBox').style.display = '';
      $('pendingBox').style.display = 'none';
      authScreen.classList.remove('hidden');
      splashAuthDone = true; maybeHideSplash();
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
